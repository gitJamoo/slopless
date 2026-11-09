import '@/lib/ui.css';
import { browser } from 'wxt/browser';
import { send, type StatusResponse } from '@/lib/messages';
import { updateSettings, type Mode } from '@/lib/settings';

const $ = (id: string) => document.getElementById(id)!;

function bindSeg(id: string, value: string, onPick: (v: string) => void) {
  const group = $(id);
  const paint = (v: string) =>
    group.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === v)));
  paint(value);
  group.querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', () => {
      paint(b.dataset.v!);
      onPick(b.dataset.v!);
    }),
  );
}

function setEngine(dot: 'ok' | 'bad' | '', text: string) {
  const d = document.createElement('span');
  d.className = `dot ${dot}`;
  $('engine').replaceChildren(d, text);
}

async function main() {
  const { settings, stats, engine } = await send<StatusResponse>({ type: 'status' });

  bindSeg('mode', settings.mode, (v) => updateSettings({ mode: v as Mode }));
  $('s-scanned').textContent = String(stats.scanned);
  $('s-flagged').textContent = String(stats.flagged);
  if (stats.scanned) $('s-ms').textContent = String(Math.round(stats.modelMs / stats.scanned));

  if (!engine.modelPresent) setEngine('bad', 'No model installed (see Settings).');
  else if (engine.standIn) setEngine('bad', 'Stand-in model: speed testing only, verdicts are random.');
  else if (engine.loaded) setEngine('ok', `Model loaded${engine.modelMB ? ` · ${engine.modelMB} MB` : ''}`);
  else setEngine('', 'Model ready · loads when you scroll, unloads when idle');

  $('open-options').addEventListener('click', (ev) => {
    ev.preventDefault();
    browser.runtime.openOptionsPage();
  });
}
main();
