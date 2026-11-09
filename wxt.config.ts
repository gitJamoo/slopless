import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'wxt';

export default defineConfig({
  manifestVersion: 3,
  hooks: {
    // ONNX Runtime's bundle makes Vite emit a second 27MB copy of the WASM binary.
    // We load it from /ort (wasmPaths in lib/engine.ts), so drop the duplicate.
    'build:done': (wxt) => {
      const assets = join(wxt.config.outDir, 'assets');
      try {
        for (const f of readdirSync(assets)) if (/^ort-wasm.*\.wasm$/.test(f)) rmSync(join(assets, f));
      } catch {}
    },
  },
  manifest: ({ browser }) => ({
    name: 'Slopless',
    description:
      'Flags, hides, or rewrites AI-generated posts in your feed. Detection runs on your device by default.',
    permissions: browser === 'firefox' ? ['storage'] : ['storage', 'offscreen'],
    // Only the Pangram API is contacted, and only if you choose a Pangram mode.
    host_permissions: ['https://text.external-api.pangram.com/*'],
    // Requested at runtime, only if you point "Rewrite" at your own LLM endpoint.
    optional_host_permissions: ['http://*/*', 'https://*/*'],
    content_security_policy: {
      // transformers.js / ONNX Runtime compile WebAssembly; nothing is loaded remotely.
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
    },
    // Cross-origin isolation lets ONNX Runtime use multiple WASM threads (big CPU speedup).
    ...(browser === 'firefox'
      ? {}
      : {
          cross_origin_embedder_policy: { value: 'require-corp' },
          cross_origin_opener_policy: { value: 'same-origin' },
        }),
    browser_specific_settings:
      browser === 'firefox'
        ? { gecko: { id: 'slopless@example.dev', strict_min_version: '128.0' } }
        : undefined,
  }),
});
