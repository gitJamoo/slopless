// The on-device engine. Runs in the Chrome offscreen document, or directly in
// Firefox's background page. Nothing in here touches the network: the model and
// the ONNX Runtime binaries ship inside the extension.
import { AutoModelForSequenceClassification, AutoTokenizer, env } from '@huggingface/transformers';
import { browser } from 'wxt/browser';
import type { BenchResponse, EngineRequest, EngineStatus } from './messages';
import { bucketScore, cleanForModel } from './text';

export const MODEL_ID = 'editlens-roberta-large';

interface ModelMeta {
  stand_in?: boolean;
  dtypes: string[]; // which onnx/model_<suffix>.onnx files exist, e.g. ["q8", "q4"]
  n_buckets: number;
  max_length: number;
}

const url = (p: string) => browser.runtime.getURL(p as any);

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.useBrowserCache = false; // files are already local; caching would just duplicate ~360MB
env.localModelPath = url('/models/');
const onnx = env.backends.onnx as any;
onnx.wasm.wasmPaths = {
  mjs: url('/ort/ort-wasm-simd-threaded.asyncify.mjs'),
  wasm: url('/ort/ort-wasm-simd-threaded.asyncify.wasm'),
};
// Threads need cross-origin isolation (set in the manifest for Chrome).
onnx.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;

interface Loaded {
  tokenizer: any;
  model: any;
  device: string;
  dtype: string;
  loadMs: number;
  meta: ModelMeta;
}

let loading: Promise<Loaded> | null = null;
let lastError: string | undefined;
let runs = 0;
let totalMs = 0;
let modelPresent: boolean | undefined;
let standIn = false;

async function readMeta(): Promise<ModelMeta | null> {
  try {
    const res = await fetch(url(`/models/${MODEL_ID}/slopless.json`));
    modelPresent = res.ok;
    if (!res.ok) return null;
    const meta: ModelMeta = await res.json();
    standIn = !!meta.stand_in;
    return meta;
  } catch {
    modelPresent = false;
    return null;
  }
}

async function hasWebGPU(): Promise<boolean> {
  try {
    const gpu = (navigator as any).gpu;
    return !!(gpu && (await gpu.requestAdapter()));
  } catch {
    return false;
  }
}

async function load(): Promise<Loaded> {
  const meta = await readMeta();
  if (!meta) {
    throw new Error('On-device model not installed. Run scripts/convert_model.py, then rebuild. See README.');
  }
  const t0 = performance.now();
  const tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID);

  // WebGPU wants 4-bit weights (MatMulNBits); WASM is fastest with 8-bit.
  const plans: Array<[string, string]> = [];
  if ((await hasWebGPU()) && meta.dtypes.includes('q4')) plans.push(['webgpu', 'q4']);
  if (meta.dtypes.includes('q8')) plans.push(['wasm', 'q8']);
  if (meta.dtypes.includes('q4')) plans.push(['wasm', 'q4']);

  let lastErr: unknown;
  for (const [device, dtype] of plans) {
    try {
      const model = await AutoModelForSequenceClassification.from_pretrained(MODEL_ID, {
        device: device as any,
        dtype: dtype as any,
      });
      return { tokenizer, model, device, dtype, meta, loadMs: Math.round(performance.now() - t0) };
    } catch (e) {
      lastErr = e;
      console.warn(`[slopless] ${device}/${dtype} failed, trying next`, e);
    }
  }
  throw lastErr ?? new Error('No usable model file');
}

function ensureLoaded(): Promise<Loaded> {
  if (!loading) {
    loading = load().catch((e) => {
      loading = null;
      lastError = String(e?.message ?? e);
      throw e;
    });
  }
  return loading;
}

async function detect(texts: string[], maxTokens: number) {
  const m = await ensureLoaded();
  const cleaned = texts.map(cleanForModel);
  const t0 = performance.now();
  const inputs = m.tokenizer(cleaned, {
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
  if (modelPresent === undefined) await readMeta();
  const m = loading ? await loading.catch(() => null) : null;
  return {
    loaded: !!m,
    modelPresent: !!modelPresent,
    standIn,
    device: m?.device,
    dtype: m?.dtype,
    loadMs: m?.loadMs,
    avgMs: runs ? Math.round(totalMs / runs) : undefined,
    runs,
    crossOriginIsolated: self.crossOriginIsolated,
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
  const tokens = m.tokenizer(cleanForModel(text), { truncation: true, max_length: maxTokens }).input_ids.dims[1];
  await detect([text], maxTokens); // warm-up (shader compile / JIT)
  const times: number[] = [];
  for (let i = 0; i < runCount; i++) {
    const t0 = performance.now();
    await detect([text + ' ' + i], maxTokens);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const t0 = performance.now();
  await detect(Array.from({ length: 8 }, (_, i) => `${i} ${text}`), maxTokens);
  const batch8 = (performance.now() - t0) / 8;
  return {
    device: m.device,
    dtype: m.dtype,
    loadMs: m.loadMs,
    tokens,
    runs: runCount,
    medianMs: Math.round(times[Math.floor(times.length / 2)]!),
    p90Ms: Math.round(times[Math.min(times.length - 1, Math.floor(times.length * 0.9))]!),
    batch8PerPostMs: Math.round(batch8),
  };
}

/** Chrome's on-device Rewriter API (Gemini Nano). Never leaves the machine. */
async function rewriteBuiltin(text: string): Promise<string> {
  const R = (self as any).Rewriter;
  if (!R) throw new Error("This browser has no built-in Rewriter. Set an LLM endpoint in Slopless options.");
  const opts = {
    tone: 'more-casual',
    length: 'as-is',
    format: 'plain-text',
    sharedContext:
      'Social media posts. Rewrite so it reads like a real person typed it: plain words, specific, no hype, no filler, no em dashes. Keep every fact.',
  };
  const avail = await R.availability(opts);
  if (avail !== 'available') {
    throw new Error('On-device rewriter not downloaded yet. Open Slopless options and click "Download rewriter".');
  }
  const rewriter = await R.create(opts);
  try {
    return (await rewriter.rewrite(text)).trim();
  } finally {
    rewriter.destroy?.();
  }
}

export async function handleEngine(msg: EngineRequest): Promise<unknown> {
  switch (msg.type) {
    case 'detect':
      return { ok: true, results: await detect(msg.texts, msg.maxTokens) };
    case 'status':
      return status();
    case 'benchmark':
      return { ok: true, ...(await benchmark(msg.runs, msg.words, msg.maxTokens)) };
    case 'rewrite':
      return { ok: true, text: await rewriteBuiltin(msg.text) };
  }
}
