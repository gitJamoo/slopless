// Copies the ONNX Runtime WASM files into public/ort so the extension never
// loads code from a CDN (MV3 forbids remote code, and it's a privacy leak).
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Prefer the copy nested under transformers (exact version match), else the hoisted one.
const candidates = [
  'node_modules/@huggingface/transformers/node_modules/onnxruntime-web/dist',
  'node_modules/onnxruntime-web/dist',
].map((p) => join(process.cwd(), p));
const ortDist = candidates.find((p) => existsSync(p));
if (!ortDist) throw new Error('onnxruntime-web not installed');
const out = join(process.cwd(), 'public/ort');
mkdirSync(out, { recursive: true });
for (const f of ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm']) {
  const src = join(ortDist, f);
  if (!existsSync(src)) throw new Error(`missing ${src}`);
  cpSync(src, join(out, f));
}
console.log(`copied ONNX Runtime wasm -> public/ort`);
