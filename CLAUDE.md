# Slopless

A browser extension (WXT + TypeScript) that flags, hides, or rewrites AI-generated posts. Detection runs on-device (transformers.js + ONNX Runtime Web), through the Pangram API, or as a hybrid of the two. See `README.md` for architecture and measured numbers.

- **Model training work:** follow `training/PLAN.md` phase by phase. Stop at each gate and log to `training/LOG.md`.
- **Checks:** `npm test` (unit), `npm run typecheck`, then `npm run build && node scripts/e2e.mjs` (headless Chromium end-to-end; needs a model in `public/models/`).
- **Privacy is the product.**
  - The on-device path must never make network requests.
  - Post text is never stored; only hashes and scores are.
  - Settings live in `storage.local`.
- **Licensing:**
  - Open Pangram weights (CC BY-NC-SA, gated) are never committed or shipped.
  - Training data must be license-clean. Tweets are for evaluation only.
