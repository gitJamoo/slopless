import './style.css';
import { adapterFor } from '@/lib/adapters';
import { send, type Result, type Score } from '@/lib/messages';
import { getSettings, onSettingsChanged, type Settings } from '@/lib/settings';
import { countWords, normalizePostText } from '@/lib/text';

interface PostState {
  text: string;
  textEl: HTMLElement;
  result?: Score;
  error?: string;
  rewritten?: string;
  rewriting?: boolean;
  showOriginal?: boolean;
}

export default defineContentScript({
  matches: [
    '*://*.x.com/*',
    '*://*.twitter.com/*',
    '*://*.reddit.com/*',
    '*://*.linkedin.com/*',
    '*://*.bsky.app/*',
    'http://localhost/*',
    'http://127.0.0.1/*',
  ],
  runAt: 'document_idle',
  async main(ctx) {
    const adapter = adapterFor(location.hostname);
    if (!adapter) return;

    let settings: Settings = await getSettings();
    const states = new Map<Element, PostState>();
    const active = () => settings.mode !== 'off' && settings.sites[adapter.id];

    // ---- discover posts; only score ones near the viewport (feeds pre-render ahead of you) ----
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => e.isIntersecting && consider(e.target)),
      { rootMargin: '1500px 0px 1500px 0px' },
    );
    const seen = new WeakSet<Element>();
    const scan = (root: ParentNode) => {
      root.querySelectorAll(adapter.post).forEach((p) => {
        if (seen.has(p)) return consider(p); // re-check: virtualised feeds recycle nodes
        seen.add(p);
        io.observe(p);
      });
    };
    let scanQueued = false;
    const mo = new MutationObserver(() => {
      if (scanQueued) return;
      scanQueued = true;
      requestAnimationFrame(() => {
        scanQueued = false;
        if (active()) scan(document);
      });
    });

    function consider(post: Element) {
      if (!active()) return;
      const textEl = adapter!.text(post);
      if (!textEl) return;
      const text = normalizePostText(textEl.innerText ?? '');
      const prev = states.get(post);
      if (prev && prev.text === text && prev.textEl === textEl) return;
      if (prev) clearUi(post, prev);
      if (countWords(text) < settings.minWords) {
        states.delete(post);
        return;
      }
      const st: PostState = { text, textEl };
      states.set(post, st);
      if (settings.blurWhileChecking) textEl.classList.add('slopless-pending');
      // Fail open: never leave a post blurred if scoring stalls.
      const failOpen = setTimeout(() => textEl.classList.remove('slopless-pending'), 10_000);
      send<Result<Score>>({ type: 'score', text }).then((r) => {
        clearTimeout(failOpen);
        if (states.get(post) !== st) return;
        if (r?.ok) st.result = r;
        else st.error = r?.error ?? 'Unknown error';
        render(post, st);
      });
    }

    // ---- UI ----
    function clearUi(post: Element, st: PostState) {
      post.querySelectorAll(':scope .slopless-ui').forEach((n) => n.remove());
      post.removeAttribute('data-slopless-hidden');
      st.textEl.classList.remove('slopless-pending', 'slopless-replaced');
    }

    function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string) {
      const n = document.createElement(tag);
      n.className = `slopless-ui ${cls}`;
      if (text) n.textContent = text;
      return n;
    }

    function badge(st: PostState) {
      const r = st.result!;
      const pct = Math.round(r.score * 100);
      const b = el('span', `slopless-badge slopless-${r.verdict}`, `${r.verdict === 'human' ? '✓' : '⚠'} ${r.label} · ${pct}%`);
      b.title = `Slopless: ${r.label} (${pct}% AI) via ${r.source === 'local' ? 'on-device Open Pangram' : 'Pangram API'}` +
        `${r.cached ? ', cached' : `, ${r.ms} ms`}`;
      return b;
    }

    function render(post: Element, st: PostState) {
      clearUi(post, st);
      if (!active()) return;
      const { textEl } = st;
      if (st.error) {
        if (st.error.includes('not installed') || st.error.includes('API key')) {
          const b = el('span', 'slopless-badge slopless-error', '⚠ Slopless needs setup');
          b.title = st.error;
          textEl.before(b);
        }
        return;
      }
      const r = st.result!;
      const isAi = r.verdict === 'ai';

      if (settings.mode === 'flag' || !isAi) {
        if (r.verdict !== 'human') textEl.before(badge(st));
        return;
      }

      if (settings.mode === 'hide') {
        // Collapse the whole post, unless its content lives in a shadow root (new Reddit):
        // light-DOM children we add there wouldn't render, so collapse just the text.
        const whole = !post.shadowRoot;
        const bar = el('div', 'slopless-bar', `Hidden by Slopless: ${r.label} (${Math.round(r.score * 100)}%) `);
        const show = el('button', 'slopless-link', 'Show');
        show.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          post.removeAttribute('data-slopless-hidden');
          textEl.classList.remove('slopless-replaced');
          bar.remove();
          textEl.before(badge(st));
        };
        bar.append(show);
        if (whole) {
          post.setAttribute('data-slopless-hidden', '');
          post.prepend(bar);
        } else {
          textEl.classList.add('slopless-replaced');
          textEl.before(bar);
        }
        return;
      }

      // rewrite: keep the site's own node untouched (React owns it); show ours beside it.
      textEl.before(badge(st));
      if (st.showOriginal) return;
      if (!st.rewritten) {
        if (!st.rewriting) {
          st.rewriting = true;
          send<Result<{ text: string }>>({ type: 'rewrite', text: st.text }).then((res) => {
            st.rewriting = false;
            if (states.get(post) !== st) return;
            if (res?.ok && res.text) {
              st.rewritten = res.text;
            } else {
              // Rewrite unavailable: fall back to showing the original with its badge.
              st.showOriginal = true;
              console.warn('[slopless] rewrite failed:', res?.ok === false ? res.error : res);
            }
            render(post, st);
          });
        }
        textEl.classList.add('slopless-pending');
        return;
      }
      textEl.classList.add('slopless-replaced');
      const box = el('div', 'slopless-rewrite');
      box.append(document.createTextNode(st.rewritten));
      const toggle = el('button', 'slopless-link', 'Rewritten by Slopless · show original');
      toggle.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        st.showOriginal = true;
        render(post, st);
      };
      box.append(toggle);
      textEl.after(box);
    }

    function rerenderAll() {
      for (const [post, st] of states) {
        if (!post.isConnected) states.delete(post);
        else if (st.result || st.error) render(post, st);
      }
    }

    onSettingsChanged((s) => {
      const thresholdChanged = s.threshold !== settings.threshold;
      settings = s;
      if (!active()) {
        for (const [post, st] of states) clearUi(post, st);
        states.clear();
        return;
      }
      if (thresholdChanged) {
        // cached scores get a fresh verdict from the background
        for (const [post, st] of states) {
          clearUi(post, st);
          states.delete(post);
        }
      }
      rerenderAll();
      scan(document);
    });

    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    ctx.onInvalidated(() => {
      mo.disconnect();
      io.disconnect();
    });
    if (active()) scan(document);
  },
});
