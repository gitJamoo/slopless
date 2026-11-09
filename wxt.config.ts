import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defineConfig } from 'wxt';

// CPU-only ONNX Runtime (14 MB WASM) instead of the WebGPU build (27 MB). Slopless never
// touches the GPU. transformers.js imports `onnxruntime-web/webgpu`, so redirect that import.
const ortDist = ['node_modules/@huggingface/transformers/node_modules/onnxruntime-web/dist', 'node_modules/onnxruntime-web/dist']
  .map((p) => resolve(p))
  .find((p) => existsSync(p))!;

export default defineConfig({
  manifestVersion: 3,
  vite: () => ({
    resolve: { alias: { 'onnxruntime-web/webgpu': join(ortDist, 'ort.wasm.min.mjs') } },
  }),
  hooks: {
    // Safety net: never ship a second, bundler-emitted copy of the WASM binary.
    'build:done': (wxt) => {
      const assets = join(wxt.config.outDir, 'assets');
      try {
        for (const f of readdirSync(assets)) if (/^ort-wasm.*\.wasm$/.test(f)) rmSync(join(assets, f));
      } catch {}
    },
  },
  manifest: ({ browser }) => ({
    name: 'Slopless',
    description: 'Flags or hides AI-generated posts in your feed. A small model runs on your device; nothing is sent anywhere.',
    permissions: browser === 'firefox' ? ['storage'] : ['storage', 'offscreen'],
    content_security_policy: {
      // ONNX Runtime compiles WebAssembly; nothing is loaded remotely.
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
    },
    // Cross-origin isolation lets ONNX Runtime use WASM threads.
    ...(browser === 'firefox'
      ? {}
      : {
          cross_origin_embedder_policy: { value: 'require-corp' },
          cross_origin_opener_policy: { value: 'same-origin' },
        }),
    browser_specific_settings:
      browser === 'firefox'
        ? { gecko: { id: 'slopless@slopless.dev', strict_min_version: '128.0' } }
        : undefined,
  }),
});
