// Copies ONNX Runtime's CPU-only WASM into public/ort so the extension never loads code
// from a CDN (MV3 forbids remote code, and it would leak usage).
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const ortDist = [
  'node_modules/@huggingface/transformers/node_modules/onnxruntime-web/dist',
  'node_modules/onnxruntime-web/dist',
]
  .map((p) => join(process.cwd(), p))
  .find((p) => existsSync(p));
if (!ortDist) throw new Error('onnxruntime-web not installed');

const out = join(process.cwd(), 'public/ort');
rmSync(out, { recursive: true, force: true }); // drop stale builds (e.g. the old WebGPU runtime)
mkdirSync(out, { recursive: true });
for (const f of ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) {
  cpSync(join(ortDist, f), join(out, f));
}
console.log('copied ONNX Runtime (CPU) wasm -> public/ort');
