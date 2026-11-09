# Slopless

Browser extension (WXT + TypeScript) that flags or hides AI-generated posts using a small classifier running on-device (transformers.js + ONNX Runtime Web, CPU-only). See README.md for architecture and ROADMAP.md for what's next.

- **Model training:** follow `training/PLAN.md` phase by phase. Stop at each gate and log to `training/LOG.md`.
- **Checks:** `npm test` (JS + Python normalization twin), `npm run typecheck`, `npm run build && npm run e2e` (headless Chromium; needs a model in `public/models/slopless-x/`, e.g. `python scripts/export_model.py --model jhu-clsp/ettin-encoder-17m --stand-in`).
- **Normalization parity:** `normalizeForModel` (lib/text.ts) and `training/slopdata/normalize.py` must stay identical; both are tested against `training/normalize_cases.json`.
- **Privacy is the product.** The extension makes no network requests. Post text is never stored (only hashes and scores). Account verdicts live in memory for the session only.
- **Licensing:** training data must be license-clean. Tweets are for evaluation only. Pangram's model and outputs are never used for training.
