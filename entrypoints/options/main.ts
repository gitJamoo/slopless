import '@/lib/ui.css';
import { send, type BenchResponse, type Result, type Score, type StatusResponse } from '@/lib/messages';
import { getSettings, updateSettings, type Settings, type SiteId } from '@/lib/settings';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let savedTimer: ReturnType<typeof setTimeout> | undefined;
function flashSaved() {
  $('saved').classList.add('on');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => $('saved').classList.remove('on'), 1200);
}

function bindFields(s: Settings) {
  document.querySelectorAll<HTMLInputElement>('[data-k]').forEach((el) => {
    const k = el.dataset.k as keyof Settings;
    if (el.type === 'checkbox') el.checked = Boolean(s[k]);
    else el.value = String(s[k] ?? '');
    el.addEventListener('change', async () => {
      const value = el.type === 'checkbox' ? el.checked : Number(el.value);
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

function line(...parts: (string | Node)[]) {
  const p = document.createElement('div');
  p.append(...parts);
  return p;
}

async function showEngine() {
  const { engine } = await send<StatusResponse>({ type: 'status' });
  const e = $('engine');
  const bench = $('bench') as HTMLButtonElement;
  if (!engine.modelPresent) {
    e.replaceChildren(line('No model installed. See the README: "Train or export a model".'));
    bench.disabled = true;
    return;
  }
  const rows = [
    line(`${engine.modelName ?? 'Model'}${engine.modelMB ? ` · ${engine.modelMB} MB` : ''} · CPU · ${engine.threads} thread(s)`),
    line(
      engine.loaded
        ? `Loaded in ${engine.loadMs} ms${engine.avgMs ? ` · avg ${engine.avgMs} ms/post over ${engine.runs} posts` : ''}`
        : 'Not loaded. It loads when you scroll and unloads after 3 idle minutes.',
    ),
  ];
  if (engine.standIn) rows.push(line('⚠ Stand-in model (untrained head): useful for speed tests only; verdicts are random.'));
  e.replaceChildren(...rows);
}

function out(id: string, text: string) {
  const pre = $(id);
  pre.hidden = false;
  pre.textContent = text;
}

async function main() {
  bindFields(await getSettings());
  showEngine();

  $('bench').addEventListener('click', async () => {
    const btn = $('bench') as HTMLButtonElement;
    btn.disabled = true;
    out('bench-out', 'Loading model and running…');
    const lines: string[] = [];
    for (const words of [20, 60, 150]) {
      const r = await send<Result<BenchResponse>>({ type: 'benchmark', runs: 7, words });
      if (!r.ok) {
        lines.push(`Error: ${r.error}`);
        break;
      }
      lines.push(
        `${String(words).padStart(3)} words (${r.tokens} tokens): median ${r.medianMs} ms, p90 ${r.p90Ms} ms, ` +
          `batched ×8: ${r.batch8PerPostMs} ms/post   [load ${r.loadMs} ms]`,
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
        ? `${r.label}: ${Math.round(r.score * 100)}% AI (${r.ms} ms)\nclass probabilities: ${r.probs?.map((p) => p.toFixed(3)).join(', ')}`
        : `Error: ${r.error}`,
    );
  });
}
main();
