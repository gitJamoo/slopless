import './style.css';
import { adapterFor } from '@/lib/adapters';
import { send, type Result, type Score } from '@/lib/messages';
import { getSettings, onSettingsChanged, type Settings } from '@/lib/settings';
import { accountVerdict, countWords, normalizePostText } from '@/lib/text';

/** Posts this short are too thin to judge alone, but still count toward their author's verdict. */
const ACCOUNT_MIN_WORDS = 5;

interface PostState {
  text: string;
  textEl: HTMLElement;
  author: string | null;
  /** Long enough to get its own badge (≥ minWords). */
  ownVerdict: boolean;
  result?: Score;
  error?: string;
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
    // Session-only, in-memory: author -> (post text -> score). Never persisted.
    const accounts = new Map<string, Map<string, number>>();
    const active = () => settings.mode !== 'off' && settings.sites[adapter.id];

    // ---- discover posts; score only those near the viewport (feeds render ahead of you) ----
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => e.isIntersecting && consider(e.target)),
      { rootMargin: '1200px 0px 1200px 0px' },
    );
    const seen = new WeakSet<Element>();
    const scan = () => {
      document.querySelectorAll(adapter.post).forEach((p) => {
        if (seen.has(p)) return consider(p); // re-check: virtualised feeds recycle nodes
        seen.add(p);
        io.observe(p);
      });
    };
    let scanQueued = false;
    const mo = new MutationObserver(() => {
      if (scanQueued || document.hidden) return;
      scanQueued = true;
      requestAnimationFrame(() => {
        scanQueued = false;
        if (active()) scan();
      });
    });

    function consider(post: Element) {
      if (!active() || document.hidden) return;
      const textEl = adapter!.text(post);
      if (!textEl) return;
      const text = normalizePostText(textEl.innerText ?? '');
      const prev = states.get(post);
      if (prev && prev.text === text && prev.textEl === textEl) return;
      if (prev) clearUi(post, prev);
      const words = countWords(text);
      const author = adapter!.author?.(post) ?? null;
      const ownVerdict = words >= settings.minWords;
      const forAccount = settings.accountVerdicts && !!author && words >= ACCOUNT_MIN_WORDS;
      if (!ownVerdict && !forAccount) {
        states.delete(post);
        return;
      }
      const st: PostState = { text, textEl, author, ownVerdict };
      states.set(post, st);
      if (ownVerdict && settings.blurWhileChecking) textEl.classList.add('slopless-pending');
      const failOpen = setTimeout(() => textEl.classList.remove('slopless-pending'), 10_000);
      send<Result<Score>>({ type: 'score', text }).then((r) => {
        clearTimeout(failOpen);
        if (states.get(post) !== st) return;
        if (r?.ok) st.result = r;
        else st.error = r?.error ?? 'Unknown error';
        if (st.result && author) recordAccount(author, text, st.result.score);
        else render(post, st);
      });
    }

    function recordAccount(author: string, text: string, score: number) {
      let m = accounts.get(author);
      if (!m) accounts.set(author, (m = new Map()));
      const before = accountVerdict([...m.values()], settings.threshold);
      m.set(text, score);
      const after = accountVerdict([...m.values()], settings.threshold);
      // Account verdict exists or just changed: re-render all their posts (keeps counts current).
      const all = !!before || !!after;
      for (const [p, s] of states) if (s.author === author && (all || s.text === text)) render(p, s);
    }

    // ---- UI ----
    function clearUi(post: Element, st: PostState) {
      post.querySelectorAll('.slopless-ui').forEach((n) => n.parentNode?.removeChild(n));
      post.removeAttribute('data-slopless-hidden');
      st.textEl.classList.remove('slopless-pending', 'slopless-replaced');
    }

    function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string) {
      const n = document.createElement(tag);
      n.className = `slopless-ui ${cls}`;
      if (text) n.textContent = text;
      return n;
    }

    function render(post: Element, st: PostState) {
      clearUi(post, st);
      if (!active()) return;
      const { textEl } = st;

      if (st.error) {
        if (st.ownVerdict) {
          const b = el('span', 'slopless-badge slopless-error', '⚠ Slopless: no model');
          b.title = st.error;
          textEl.before(b);
        }
        return;
      }
      if (!st.result) return;

      const r = st.result;
      const acct = st.author && settings.accountVerdicts
        ? accountVerdict([...(accounts.get(st.author)?.values() ?? [])], settings.threshold)
        : null;
      const postIsAi = st.ownVerdict && r.verdict === 'ai';
      const isAi = postIsAi || !!acct;

      const badges: HTMLElement[] = [];
      if (st.ownVerdict && r.verdict !== 'human') {
        const pct = Math.round(r.score * 100);
        const b = el('span', `slopless-badge slopless-${r.verdict}`, `${r.label} · ${pct}%`);
        b.title = `Slopless on-device model: ${pct}% AI${r.cached ? ' (cached)' : `, ${r.ms} ms`}`;
        badges.push(b);
      }
      if (acct) {
        const b = el('span', 'slopless-badge slopless-account', `Account: mostly AI · ${acct.n} posts`);
        b.title = `${Math.round(acct.aiShare * 100)}% of this account's posts you've seen this session scored as AI. Nothing is saved.`;
        badges.push(b);
      }

      if (settings.mode === 'hide' && isAi) {
        const why = postIsAi ? `${r.label} (${Math.round(r.score * 100)}%)` : `account posts mostly AI (${acct!.n} posts)`;
        const bar = el('div', 'slopless-bar', `Hidden by Slopless: ${why} `);
        const show = el('button', 'slopless-link', 'Show');
        show.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          post.removeAttribute('data-slopless-hidden');
          textEl.classList.remove('slopless-replaced');
          bar.parentNode?.removeChild(bar);
          textEl.before(...badges);
        };
        bar.append(show);
        // Collapse the whole post unless its content lives in a shadow root (new Reddit).
        if (!post.shadowRoot) {
          post.setAttribute('data-slopless-hidden', '');
          post.prepend(bar);
        } else {
          textEl.classList.add('slopless-replaced');
          textEl.before(bar);
        }
        return;
      }
      if (badges.length) textEl.before(...badges);
    }

    function rerenderAll() {
      for (const [post, st] of states) {
        if (!post.isConnected) states.delete(post);
        else render(post, st);
      }
    }

    onSettingsChanged((s) => {
      const rescore = s.threshold !== settings.threshold || s.minWords !== settings.minWords || s.maxTokens !== settings.maxTokens;
      settings = s;
      if (!active() || rescore) {
        for (const [post, st] of states) clearUi(post, st);
        states.clear();
        accounts.clear();
      }
      if (!active()) return;
      rerenderAll();
      scan();
    });

    document.addEventListener('visibilitychange', () => !document.hidden && active() && scan());
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    ctx.onInvalidated(() => {
      mo.disconnect();
      io.disconnect();
    });
    if (active()) scan();
  },
});
