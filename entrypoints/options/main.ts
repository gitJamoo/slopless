import '@/lib/ui.css';
import { browser } from 'wxt/browser';
import { send, type BenchResponse, type Result, type Score, type StatusResponse } from '@/lib/messages';
import { getSettings, updateSettings, type Settings, type SiteId } from '@/lib/settings';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let savedTimer: ReturnType<typeof setTimeout> | undefined;
function flashSaved() {
  $('saved').classList.add('on');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => $('saved').classList.remove('on'), 1200);
}

async function bindFields(s: Settings) {
  document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-k]').forEach((el) => {
    const k = el.dataset.k as keyof Settings;
    const v = s[k];
    if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = Boolean(v);
    else el.value = String(v ?? '');
    el.addEventListener('change', async () => {
      let value: unknown = el.value;
      if (el instanceof HTMLInputElement && el.type === 'checkbox') value = el.checked;
      else if (el instanceof HTMLInputElement && el.type === 'number') value = Number(el.value);
      else if (typeof value === 'string') value = value.trim();
      if (k === 'openaiBaseUrl' && typeof value === 'string' && value) await requestOrigin(value);
      await updateSettings({ [k]: value } as Partial<Settings>);
      flashSaved();
    });
  });
  document.querySelectorAll<HTMLInputElement>('[data-site]').forEach((el) => {
    const id = el.dataset.site as SiteId;
    el.checked = s.sites[id];
    el.addEventListener('change', async () => {
      const cur = await getSettings();
      await updateSettings({ sites: { ...cur.sites, [id]: el.checked } });
      flashSaved();
    });
  });
}

/** Ask for host permission for a custom LLM endpoint (must run in a click/change handler). */
async function requestOrigin(base: string) {
  try {
    const u = new URL(base);
    const granted = await browser.permissions.request({ origins: [`${u.protocol}//${u.hostname}/*`] });
    $('rw-note').textContent = granted ? '' : 'Permission denied: Slopless cannot reach that endpoint.';
  } catch {
    $('rw-note').textContent = 'That is not a valid URL.';
  }
}

async function showEngine() {
  const { engine } = await send<StatusResponse>({ type: 'status' });
  const e = $('engine');
  if (!engine.modelPresent) {
    e.innerHTML =
      '<span class="dot bad"></span>Not installed. Request access to <code>pangram/editlens_roberta-large</code> on Hugging Face, ' +
      'run <code>python scripts/convert_model.py</code>, then rebuild. Pangram API mode works without it.';
    ($('bench') as HTMLButtonElement).disabled = true;
    return;
  }
  e.innerHTML = engine.loaded
    ? `<span class="dot ok"></span>Loaded on <b>${engine.device}</b> (${engine.dtype}) in ${engine.loadMs} ms` +
      (engine.avgMs ? ` · avg ${engine.avgMs} ms/post over ${engine.runs} posts` : '')
    : '<span class="dot"></span>Installed. Loads on first use.';
  if (engine.standIn)
    e.innerHTML += '<br><b>Stand-in model</b> (untrained head): good for speed tests, verdicts are meaningless.';
  e.innerHTML += `<br><span class="muted">Threads: ${engine.threads}${engine.crossOriginIsolated ? '' : ' (no cross-origin isolation)'}</span>`;
}

function out(id: string, text: string) {
  const pre = $(id);
  pre.hidden = false;
  pre.textContent = text;
}

async function main() {
  await bindFields(await getSettings());
  showEngine();

  $('bench').addEventListener('click', async () => {
    const btn = $('bench') as HTMLButtonElement;
    btn.disabled = true;
    out('bench-out', 'Loading model and running… (first load can take 10–30 s)');
    const lines: string[] = [];
    for (const words of [40, 100, 250]) {
      const r = await send<Result<BenchResponse>>({ type: 'benchmark', runs: 5, words });
      if (!r.ok) {
        lines.push(`Error: ${r.error}`);
        break;
      }
      lines.push(
        `${String(words).padStart(3)} words (${r.tokens} tokens): median ${r.medianMs} ms, p90 ${r.p90Ms} ms, ` +
          `batched ×8: ${r.batch8PerPostMs} ms/post   [${r.device}/${r.dtype}, load ${r.loadMs} ms]`,
      );
      out('bench-out', lines.join('\n'));
    }
    btn.disabled = false;
    showEngine();
  });

  $('try').addEventListener('click', async () => {
    const text = ($('try-text') as HTMLTextAreaElement).value.trim();
    if (!text) return;
    out('try-out', 'Checking…');
    const r = await send<Result<Score>>({ type: 'test', text });
    out(
      'try-out',
      r.ok
        ? `${r.label}: ${Math.round(r.score * 100)}% AI  (${r.source}, ${r.ms} ms)` +
            (r.probs ? `\nbuckets [human, light edit, heavy edit, AI]: ${r.probs.map((p) => p.toFixed(2)).join(', ')}` : '')
        : `Error: ${r.error}`,
    );
  });

  // Chrome's built-in Rewriter needs a user click to start its one-time model download.
  $('dl-rewriter').addEventListener('click', async () => {
    const R = (self as any).Rewriter;
    if (!R) {
      $('rw-note').textContent = 'This browser has no built-in Rewriter API. Use an OpenAI-compatible endpoint (Ollama works locally).';
      return;
    }
    $('rw-note').textContent = 'Downloading…';
    try {
      const r = await R.create({
        monitor(m: any) {
          m.addEventListener('downloadprogress', (e: any) => {
            $('rw-note').textContent = `Downloading… ${Math.round(e.loaded * 100)}%`;
          });
        },
      });
      r.destroy?.();
      $('rw-note').textContent = 'Built-in rewriter ready.';
    } catch (e: any) {
      $('rw-note').textContent = `Could not download: ${e?.message ?? e}`;
    }
  });
}
main();
