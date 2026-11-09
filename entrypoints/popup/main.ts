import '@/lib/ui.css';
import { browser } from 'wxt/browser';
import { send, type StatusResponse } from '@/lib/messages';
import { updateSettings, type Detector, type Mode } from '@/lib/settings';

const $ = (id: string) => document.getElementById(id)!;
const NOTES: Record<Detector, string> = {
  local: 'Nothing leaves your device.',
  hybrid: 'Only posts the on-device model is unsure about go to Pangram.',
  pangram: 'Post text is sent to Pangram with your key.',
};

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
  const e = $('engine');
  e.replaceChildren();
  const d = document.createElement('span');
  d.className = `dot ${dot}`;
  e.append(d, text);
}

async function main() {
  const { settings, stats, engine } = await send<StatusResponse>({ type: 'status' });

  bindSeg('mode', settings.mode, (v) => updateSettings({ mode: v as Mode }));
  const note = (d: Detector) => {
    $('detector-note').textContent =
      NOTES[d] + (d !== 'local' && !settings.pangramKey ? ' Add your key in Settings.' : '');
  };
  note(settings.detector);
  bindSeg('detector', settings.detector, (v) => {
    updateSettings({ detector: v as Detector });
    note(v as Detector);
  });

  $('s-scanned').textContent = String(stats.scanned);
  $('s-flagged').textContent = String(stats.flagged);
  $('s-usd').textContent = `$${stats.pangramUsd.toFixed(2)}`;

  if (engine.standIn) setEngine('bad', 'Stand-in model installed: speed test only, verdicts are random.');
  else if (!engine.modelPresent) setEngine('bad', 'On-device model not installed (see Settings).');
  else if (engine.loaded)
    setEngine('ok', `On-device model ready · ${engine.device}/${engine.dtype}` +
      (engine.avgMs ? ` · ~${engine.avgMs} ms/post` : ''));
  else setEngine('', 'On-device model installed; loads on first post.');

  $('open-options').addEventListener('click', (ev) => {
    ev.preventDefault();
    browser.runtime.openOptionsPage();
  });
}
main();
