import { browser } from 'wxt/browser';
import { listen, send, type BgRequest, type EngineRequest, type EngineStatus, type Score } from '@/lib/messages';
import { emptyStats, getSettings, today, type DailyStats, type Settings } from '@/lib/settings';
import { hashText, VERDICT_LABEL, verdictFor } from '@/lib/text';

// ---------- engine host ----------
// The model runs in offscreen.html, never in this worker:
//  - Chromium: an offscreen document (MV3 service workers have no DOM).
//  - Firefox / Safari: no offscreen API, but their background is a page, so a hidden iframe works.
// The engine asks to be shut down after a few idle minutes; closing the document frees all its memory.

type EngineBody = EngineRequest extends infer R ? (R extends any ? Omit<R, 'target'> : never) : never;
const offscreenApi = () => (globalThis as any).chrome?.offscreen;

let hostReady: Promise<void> | null = null;
let frame: HTMLIFrameElement | null = null;

function ensureEngineHost(): Promise<void> {
  hostReady ??= (async () => {
    const offscreen = offscreenApi();
    if (offscreen?.createDocument) {
      if (await offscreen.hasDocument?.()) return;
      await offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['WORKERS'],
        justification: 'Runs the on-device AI-text classifier (WebAssembly).',
      });
      return;
    }
    await new Promise<void>((resolve, reject) => {
      frame = document.createElement('iframe');
      frame.src = browser.runtime.getURL('/offscreen.html');
      frame.onload = () => resolve();
      frame.onerror = () => reject(new Error('engine frame failed to load'));
      document.body.append(frame);
    });
  })().catch((e) => {
    hostReady = null;
    throw e;
  });
  return hostReady;
}

async function shutdownEngine() {
  hostReady = null;
  const offscreen = offscreenApi();
  if (offscreen?.closeDocument) {
    if (await offscreen.hasDocument?.()) await offscreen.closeDocument();
  } else if (frame) {
    frame.src = 'about:blank';
    frame.parentNode?.removeChild(frame);
    frame = null;
  }
}

async function engine<T>(msg: EngineBody): Promise<T> {
  await ensureEngineHost();
  const res: any = await send({ ...msg, target: 'engine' } as EngineRequest);
  if (res && res.ok === false) throw new Error(res.error);
  return res as T;
}

// ---------- stats ----------

let stats: DailyStats | null = null;
async function getStats(): Promise<DailyStats> {
  stats ??= ((await browser.storage.local.get('stats')).stats as DailyStats) ?? emptyStats();
  if (stats.date !== today() || stats.modelMs === undefined) stats = emptyStats();
  return stats;
}
let statsTimer: ReturnType<typeof setTimeout> | undefined;
async function bump(fn: (s: DailyStats) => void) {
  fn(await getStats());
  clearTimeout(statsTimer);
  statsTimer = setTimeout(() => browser.storage.local.set({ stats }), 500);
}

// ---------- cache: hash -> score. Post text itself is never stored. ----------

const CACHE_MAX = 5000;
let cache: Map<string, Score> | null = null;
async function getCache() {
  if (!cache) {
    const { scoreCache } = await browser.storage.local.get('scoreCache');
    cache = new Map(Object.entries((scoreCache as Record<string, Score>) ?? {}));
  }
  return cache;
}
let cacheTimer: ReturnType<typeof setTimeout> | undefined;
function persistCache() {
  clearTimeout(cacheTimer);
  cacheTimer = setTimeout(() => {
    if (!cache) return;
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
    browser.storage.local.set({ scoreCache: Object.fromEntries(cache) });
  }, 2000);
}

// ---------- detection with micro-batching ----------

type Pending = { text: string; resolve: (s: Score) => void; reject: (e: unknown) => void };
const queue: Pending[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let flushing = false;

function detect(text: string, s: Settings): Promise<Score> {
  return new Promise((resolve, reject) => {
    queue.push({ text, resolve, reject });
    clearTimeout(flushTimer);
    flushTimer = setTimeout(() => flush(s), queue.length >= 8 ? 0 : 30);
  });
}

async function flush(s: Settings) {
  if (flushing || !queue.length) return;
  flushing = true;
  const batch = queue.splice(0, 8);
  try {
    const { results } = await engine<{ results: { score: number; probs: number[]; ms: number }[] }>({
      type: 'detect',
      texts: batch.map((b) => b.text),
      maxTokens: s.maxTokens,
    });
    batch.forEach((b, i) => {
      const r = results[i]!;
      const verdict = verdictFor(r.score, s.threshold);
      b.resolve({ score: r.score, probs: r.probs, verdict, label: VERDICT_LABEL[verdict], ms: r.ms });
    });
  } catch (e) {
    batch.forEach((b) => b.reject(e));
  } finally {
    flushing = false;
    if (queue.length) flush(s);
  }
}

const inflight = new Map<string, Promise<Score>>();

async function score(text: string) {
  const s = await getSettings();
  const key = await hashText(`${s.maxTokens}|${text}`);
  const c = await getCache();
  const hit = c.get(key);
  if (hit) {
    const verdict = verdictFor(hit.score, s.threshold);
    return { ok: true, ...hit, verdict, label: VERDICT_LABEL[verdict], cached: true };
  }
  let p = inflight.get(key);
  if (!p) {
    p = detect(text, s).finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  const result = await p;
  c.set(key, result);
  persistCache();
  await bump((x) => {
    x.scanned++;
    x.modelMs += result.ms;
    if (result.verdict === 'ai') x.flagged++;
  });
  return { ok: true, ...result };
}

// ---------- router ----------

export default defineBackground(() => {
  listen((msg: (BgRequest | { type: 'engine-idle' }) & { target?: string }) => {
    if (msg?.target === 'engine') return undefined; // meant for the engine document
    switch (msg?.type) {
      case 'score':
        return score(msg.text);
      case 'engine-idle':
        return shutdownEngine().then(() => ({ ok: true }));
      case 'status':
        return (async () => ({
          settings: await getSettings(),
          stats: await getStats(),
          engine: await engine<EngineStatus>({ type: 'status' }).catch(
            (e): EngineStatus => ({ loaded: false, modelPresent: false, runs: 0, error: String(e) }),
          ),
        }))();
      case 'test':
        return (async () => ({ ok: true, ...(await detect(msg.text, await getSettings())) }))();
      case 'benchmark':
        return (async () => {
          const s = await getSettings();
          return engine({ type: 'benchmark', runs: msg.runs, words: msg.words, maxTokens: s.maxTokens });
        })();
    }
    return undefined;
  });
});
