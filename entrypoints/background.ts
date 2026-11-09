import { browser } from 'wxt/browser';
import { listen, send, type BgRequest, type EngineRequest, type EngineStatus, type Score } from '@/lib/messages';
import { pangramDetect } from '@/lib/pangram';
import { emptyStats, getSettings, today, type DailyStats, type Settings } from '@/lib/settings';
import { countWords, hashText, pangramCostUsd, verdictFor } from '@/lib/text';

// ---------- engine bridge (offscreen doc on Chromium, in-process on Firefox) ----------

type EngineBody = EngineRequest extends infer R ? (R extends any ? Omit<R, 'target'> : never) : never;

// The model runs in offscreen.html on every browser, never in this worker:
//  - Chromium: an offscreen document (MV3 service workers have no DOM / WebGPU).
//  - Firefox / Safari: no offscreen API, but their background is a page, so a hidden iframe works.
let hostReady: Promise<void> | null = null;
function ensureEngineHost(): Promise<void> {
  hostReady ??= (async () => {
    const offscreen = (globalThis as any).chrome?.offscreen;
    if (offscreen?.createDocument) {
      if (await offscreen.hasDocument?.()) return;
      await offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['WORKERS'],
        justification: 'Runs the on-device AI-text detector (WebAssembly/WebGPU).',
      });
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const frame = document.createElement('iframe');
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

async function engine<T>(msg: EngineBody): Promise<T> {
  await ensureEngineHost();
  const res: any = await send({ ...msg, target: 'engine' } as EngineRequest);
  if (res && res.ok === false) throw new Error(res.error);
  return res as T;
}

// ---------- stats ----------

let stats: DailyStats | null = null;
async function getStats(): Promise<DailyStats> {
  if (!stats) stats = ((await browser.storage.local.get('stats')).stats as DailyStats) ?? emptyStats();
  if (stats.date !== today()) stats = emptyStats();
  return stats;
}
let statsTimer: ReturnType<typeof setTimeout> | undefined;
async function bump(fn: (s: DailyStats) => void) {
  fn(await getStats());
  clearTimeout(statsTimer);
  statsTimer = setTimeout(() => browser.storage.local.set({ stats }), 500);
}

// ---------- cache: hash -> score only. Post text is never stored. ----------

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

// ---------- local detection with micro-batching ----------

type Pending = { text: string; resolve: (s: Score) => void; reject: (e: unknown) => void };
let queue: Pending[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let flushing = false;

function detectLocal(text: string, s: Settings): Promise<Score> {
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
      const label = { ai: 'AI-generated', edited: 'AI-edited', human: 'Human' }[verdict];
      b.resolve({ score: r.score, probs: r.probs, verdict, label, source: 'local', ms: r.ms });
    });
  } catch (e) {
    batch.forEach((b) => b.reject(e));
  } finally {
    flushing = false;
    if (queue.length) flush(s);
  }
}

// ---------- Pangram with a small concurrency limit (API allows ~5 QPS) ----------

let active = 0;
const waiters: (() => void)[] = [];
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= 3) await new Promise<void>((r) => waiters.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiters.shift()?.();
  }
}

async function detectPangram(text: string, s: Settings): Promise<Score> {
  if (!s.pangramKey) throw new Error('No Pangram API key set');
  const cost = pangramCostUsd(countWords(text));
  const st = await getStats();
  if (st.pangramUsd + cost > s.dailyBudgetUsd) throw new Error('Daily Pangram budget reached');
  const t0 = Date.now();
  const r = await withSlot(() => pangramDetect(text, s.pangramKey));
  await bump((x) => {
    x.pangramCalls++;
    x.pangramUsd = Math.round((x.pangramUsd + cost) * 100) / 100;
  });
  return { score: r.score, verdict: verdictFor(r.score, s.threshold), label: r.label, source: 'pangram', ms: Date.now() - t0 };
}

// ---------- the scoring policy ----------

const inflight = new Map<string, Promise<Score>>();

async function scoreText(text: string, s: Settings): Promise<Score> {
  switch (s.detector) {
    case 'local':
      return detectLocal(text, s);
    case 'pangram':
      return detectPangram(text, s);
    case 'hybrid': {
      // Free on-device pass first; only spend Pangram credits when the local model is unsure.
      const local = await detectLocal(text, s);
      if (local.score < s.hybridLow || local.score > s.hybridHigh || !s.pangramKey) return local;
      try {
        return await detectPangram(text, s);
      } catch {
        return local; // budget hit / network down: fall back to the local verdict
      }
    }
  }
}

async function score(text: string) {
  const s = await getSettings();
  const key = await hashText(`${s.detector}|${s.maxTokens}|${text}`);
  const c = await getCache();
  const hit = c.get(key);
  if (hit) return { ok: true, ...hit, verdict: verdictFor(hit.score, s.threshold), cached: true };

  let p = inflight.get(key);
  if (!p) {
    p = scoreText(text, s).finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  const result = await p;
  c.set(key, result);
  persistCache();
  await bump((x) => {
    x.scanned++;
    if (result.verdict === 'ai') x.flagged++;
    if (result.source === 'local') {
      x.local++;
      x.localMs += result.ms;
    }
  });
  return { ok: true, ...result };
}

// ---------- rewrite ----------

const REWRITE_PROMPT =
  'Rewrite this social media post so it reads like a normal person wrote it. Plain words, specific, no hype, ' +
  'no "it\'s not X, it\'s Y", no em dashes, no hashtags spam, no emoji lists. Keep every fact and the author\'s point. ' +
  'Same length or shorter. Reply with only the rewritten post.';

async function rewrite(text: string) {
  const s = await getSettings();
  if (s.rewriteEngine === 'builtin') return engine<{ ok: true; text: string }>({ type: 'rewrite', text });
  const res = await fetch(`${s.openaiBaseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(s.openaiKey ? { Authorization: `Bearer ${s.openaiKey}` } : {}),
    },
    body: JSON.stringify({
      model: s.openaiModel,
      temperature: 0.7,
      messages: [
        { role: 'system', content: REWRITE_PROMPT },
        { role: 'user', content: text },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Rewrite endpoint HTTP ${res.status}`);
  const json = await res.json();
  return { ok: true, text: String(json.choices?.[0]?.message?.content ?? '').trim() };
}

// ---------- router ----------

export default defineBackground(() => {
  listen((msg: BgRequest & { target?: string }) => {
    if (msg?.target === 'engine') return undefined; // meant for the offscreen doc
    switch (msg?.type) {
      case 'score':
        return score(msg.text);
      case 'rewrite':
        return rewrite(msg.text);
      case 'status':
        return (async () => ({
          settings: await getSettings(),
          stats: await getStats(),
          engine: await engine<EngineStatus>({ type: 'status' }).catch(
            (e): EngineStatus => ({ loaded: false, modelPresent: false, runs: 0, crossOriginIsolated: false, error: String(e) }),
          ),
        }))();
      case 'test':
        return (async () => {
          const s = await getSettings();
          return { ok: true, ...(await scoreText(msg.text, s)) };
        })();
      case 'benchmark':
        return (async () => {
          const s = await getSettings();
          return engine({ type: 'benchmark', runs: msg.runs, words: msg.words, maxTokens: s.maxTokens });
        })();
    }
    return undefined;
  });
});
