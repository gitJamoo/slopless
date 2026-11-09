// The on-device engine. Runs in the Chrome offscreen document, or in a hidden iframe on
// Firefox/Safari. Nothing here touches the network: the model and ONNX Runtime ship inside
// the extension. CPU only (WASM); the GPU is never used.
import { AutoModelForSequenceClassification, AutoTokenizer, env } from '@huggingface/transformers';
import { browser } from 'wxt/browser';
import type { BenchResponse, EngineRequest, EngineStatus } from './messages';
import { bucketScore, normalizeForModel } from './text';

export const MODEL_ID = 'slopless-x';
/** Shut the engine down after this long without work, so it holds no memory while you're not scrolling. */
const IDLE_MS = 3 * 60_000;
const THREADS = 2; // enough for one post at a time; leaves the rest of the CPU for the page

interface ModelMeta {
  name?: string;
  dtype?: 'q8' | 'fp32';
  n_buckets: number;
  max_length: number;
  stand_in?: boolean;
  bytes?: number;
}

const url = (p: string) => browser.runtime.getURL(p as any);

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.useBrowserCache = false; // files are already local; caching would just duplicate them
env.localModelPath = url('/models/');
const onnx = env.backends.onnx as any;
onnx.wasm.wasmPaths = {
  mjs: url('/ort/ort-wasm-simd-threaded.mjs'),
  wasm: url('/ort/ort-wasm-simd-threaded.wasm'),
};
onnx.wasm.numThreads = self.crossOriginIsolated ? Math.min(THREADS, navigator.hardwareConcurrency || 1) : 1;

interface Loaded {
  tokenizer: any;
  model: any;
  loadMs: number;
  meta: ModelMeta;
}

let loading: Promise<Loaded> | null = null;
let meta: ModelMeta | null | undefined;
let lastError: string | undefined;
let runs = 0;
let totalMs = 0;

async function readMeta(): Promise<ModelMeta | null> {
  if (meta !== undefined) return meta;
  try {
    const res = await fetch(url(`/models/${MODEL_ID}/slopless.json`));
    meta = res.ok ? await res.json() : null;
  } catch {
    meta = null;
  }
  return meta!;
}

async function load(): Promise<Loaded> {
  const m = await readMeta();
  if (!m) throw new Error('No model installed. See README → "Train or export a model".');
  const t0 = performance.now();
  const tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID);
  const model = await AutoModelForSequenceClassification.from_pretrained(MODEL_ID, {
    device: 'wasm',
    dtype: m.dtype ?? 'q8',
  });
  return { tokenizer, model, meta: m, loadMs: Math.round(performance.now() - t0) };
}

function ensureLoaded(): Promise<Loaded> {
  loading ??= load().catch((e) => {
    loading = null;
    lastError = String(e?.message ?? e);
    throw e;
  });
  return loading;
}

let idleTimer: ReturnType<typeof setTimeout> | undefined;
function touch() {
  clearTimeout(idleTimer);
  // The background closes this document when told; that frees all WASM memory at once.
  idleTimer = setTimeout(() => browser.runtime.sendMessage({ type: 'engine-idle' }).catch(() => {}), IDLE_MS);
}

async function detect(texts: string[], maxTokens: number) {
  touch();
  const m = await ensureLoaded();
  const t0 = performance.now();
  const inputs = m.tokenizer(texts.map(normalizeForModel), {
    padding: true,
    truncation: true,
    max_length: Math.min(maxTokens, m.meta.max_length),
  });
  const { logits } = await m.model(inputs);
  const rows: number[][] = logits.tolist();
  const ms = performance.now() - t0;
  runs += texts.length;
  totalMs += ms;
  return rows.map((row) => ({ ...bucketScore(row), ms: Math.round(ms / texts.length) }));
}

async function status(): Promise<EngineStatus> {
  const m = await readMeta();
  const l = loading ? await loading.catch(() => null) : null;
  return {
    loaded: !!l,
    modelPresent: !!m,
    standIn: !!m?.stand_in,
    modelName: m?.name,
    modelMB: m?.bytes ? Math.round(m.bytes / 1e6) : undefined,
    loadMs: l?.loadMs,
    avgMs: runs ? Math.round(totalMs / runs) : undefined,
    runs,
    threads: onnx.wasm.numThreads,
    error: lastError,
  };
}

const SAMPLE =
  'Honestly I did not expect the new bus route to change much, but my commute dropped by twenty minutes and I can actually read on the way in now. ';

async function benchmark(runCount: number, words: number, maxTokens: number): Promise<BenchResponse> {
  const m = await ensureLoaded();
  const base = SAMPLE.split(' ');
  const text = Array.from({ length: words }, (_, i) => base[i % base.length]).join(' ');
  const tokens = m.tokenizer(normalizeForModel(text), { truncation: true, max_length: maxTokens }).input_ids.dims[1];
  await detect([text], maxTokens); // warm-up
  const times: number[] = [];
  for (let i = 0; i < runCount; i++) {
    const t0 = performance.now();
    await detect([`${text} ${i}`], maxTokens);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const t0 = performance.now();
  await detect(Array.from({ length: 8 }, (_, i) => `${i} ${text}`), maxTokens);
  return {
    loadMs: m.loadMs,
    tokens,
    runs: runCount,
    medianMs: Math.round(times[Math.floor(times.length / 2)]!),
    p90Ms: Math.round(times[Math.min(times.length - 1, Math.floor(times.length * 0.9))]!),
    batch8PerPostMs: Math.round((performance.now() - t0) / 8),
  };
}

export async function handleEngine(msg: EngineRequest): Promise<unknown> {
  switch (msg.type) {
    case 'detect':
      return { ok: true, results: await detect(msg.texts, msg.maxTokens) };
    case 'status':
      return status();
    case 'benchmark':
      return { ok: true, ...(await benchmark(msg.runs, msg.words, msg.maxTokens)) };
  }
}

// Start the idle clock as soon as the engine document exists (e.g. opened just for a status check).
touch();
