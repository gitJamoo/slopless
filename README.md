# Slopless

A browser extension that finds AI-generated posts in your feed and **flags**, **hides**, or **rewrites** them, usually before they scroll into view.

Detection runs **on your device** by default, using Pangram's open-weights detector ([Open Pangram / EditLens](https://www.pangram.com/blog/introducing-open-pangram)). You can also use the **Pangram API**, or a **hybrid** of the two that only pays for posts the local model is unsure about.

| Mode | What happens to a likely-AI post |
|---|---|
| Off | Nothing. |
| Flag | A small badge, e.g. `⚠ AI-generated · 91%`. |
| Hide | The post collapses to "Hidden by Slopless · Show". |
| Rewrite | The text is replaced with a plain, human-sounding version, with a "show original" link. |

| Detector | Where the text goes | Cost | Accuracy |
|---|---|---|---|
| On-device | Nowhere | Free | Good. Higher false positives on non-native English (see below). |
| Hybrid | To Pangram only when the local score is in an uncertain band (default 0.35–0.85) | A fraction of API cost | Near-API |
| Pangram API | Pangram, using your own key | ~$0.05 per 100 words | Best |

Sites: X/Twitter, Reddit (new and old), LinkedIn, Bluesky, plus a local demo feed. Browsers: Chrome, Edge, Brave, Arc and other Chromium browsers (Windows, macOS, Linux, ChromeOS), and Firefox (desktop and Android). The code is Safari-compatible but not packaged for it yet.

## How it works

```
content script (one adapter per site)
  ├─ MutationObserver + IntersectionObserver (1500px look-ahead): scores posts before you reach them
  ├─ skips posts under 40 words (detectors are unreliable on short text)
  └─ blurs the post text until a verdict arrives (fails open after 10 s)
        │  runtime message: post text
        ▼
background worker
  ├─ cache: SHA-256(text) → score (post text itself is never stored)
  ├─ micro-batching (up to 8 posts / 30 ms) → one model call
  ├─ policy: local | pangram | hybrid (local first, escalate if unsure), daily $ budget
  └─ rewrite: Chrome built-in Rewriter (on-device) or any OpenAI-compatible endpoint (e.g. Ollama)
        ▼
offscreen.html (Chrome offscreen document; hidden iframe on Firefox/Safari)
  └─ transformers.js + ONNX Runtime Web: WebGPU (4-bit) → WASM (8-bit, multithreaded) fallback
       EditLens RoBERTa-large → 4 buckets [human, light AI edit, heavy AI edit, AI] → score = E[bucket]/3
```

The on-device path makes no network requests. The model and the ONNX Runtime WASM files ship inside the extension, so nothing is loaded from a CDN.

## Setup

```bash
npm install            # also copies ONNX Runtime's WASM into public/ort
```

### Option A: Pangram API only (simplest)

```bash
npm run build          # → .output/chrome-mv3
```

Load `.output/chrome-mv3` as an unpacked extension (`chrome://extensions` → Developer mode → Load unpacked). In Settings, paste your Pangram API key and choose the **Pangram** detector.

### Option B: on-device model

The weights are gated on Hugging Face and licensed CC BY-NC-SA 4.0, so each user builds them locally instead of the extension redistributing them.

1. Request access at <https://huggingface.co/pangram/editlens_roberta-large> and run `huggingface-cli login`.
2. Convert the model:
   ```bash
   python3 -m venv .venv && .venv/bin/pip install torch --index-url https://download.pytorch.org/whl/cpu
   .venv/bin/pip install transformers onnx onnxruntime onnxscript huggingface_hub
   .venv/bin/python scripts/convert_model.py --dtypes q8,q4   # ~360MB q8 for CPU, ~400MB q4 for WebGPU
   ```
   Use `--dtypes q8` for a smaller build. `--stand-in` exports the ungated `roberta-large` with a random head. It has the same speed but its scores are meaningless, so it's only useful for benchmarking without access.
3. Run `npm run build`, then load the extension. **Settings → Run speed benchmark** shows how fast it runs on your machine.

Firefox: `npm run build:firefox`, then `about:debugging` → Load Temporary Add-on → `.output/firefox-mv3/manifest.json`.

### Try it without a social login

```bash
npm run demo           # http://localhost:5179 — a fake feed of human- and AI-style posts
```

## Development

```bash
npm run dev            # Chrome with hot reload
npm test               # unit tests (text cleaning matches EditLens preprocessing, scoring, billing)
npm run typecheck
npm run build && node scripts/e2e.mjs --shots shots   # headless Chromium end-to-end, with screenshots
```

## Measured performance

Measurements from the e2e benchmark (`scripts/e2e.mjs`). Per-post latency for the RoBERTa-large architecture:

**Raspberry Pi 5** (4× Cortex-A76 @ 2.4 GHz). Headless Chromium, WASM, 8-bit, 4 threads. This is roughly what a mid-range phone CPU or an old laptop gives you.

| Post length | Tokens | Median | Batched ×8 (per post) |
|---|---|---|---|
| 40 words | 45 | 835 ms | 686 ms |
| 100 words | 107 | 1,715 ms | 1,859 ms |
| 250 words | 256 | 4,072 ms | 4,502 ms |

The model loads in 4.6 s from a cold start. For comparison, native ONNX Runtime on the same Pi runs the same 8-bit file in 315 ms at 128 tokens, so browser WASM costs about 5×. The 4-bit file is about 5× slower than 8-bit on CPU, which is why it's used only on WebGPU.

WebGPU numbers (laptops with integrated or discrete GPUs) aren't measured yet. Run **Settings → Run speed benchmark** on your machine and add a row.

## Limits and honest caveats

- **Short posts are skipped.** Most tweets are under 40 words, which is too little text for any detector to call reliably.
- **False positives matter.** Pangram reports the open RoBERTa model wrongly flags about 10% of writing by non-native English speakers, against about 0% for its paid model. The default action is therefore **Flag**, and Hide or Rewrite are always one click from the original. Hybrid mode exists for this reason.
- **Phones.** Firefox for Android runs the extension, but without WebGPU the model runs on the CPU and takes seconds per post, so use Pangram or Hybrid there. iOS Safari limits extension memory far below what the model needs. Native apps (Instagram, X) can't be inspected on iOS at all.
- **Selectors drift.** Sites change their HTML. Each site is a small adapter in `lib/adapters.ts`.
- **Rewriting is ironic.** It uses an AI model to make text sound less like AI. With Chrome's built-in Rewriter (Gemini Nano) or a local Ollama model it at least stays on your machine.

## License

Code: MIT. The Open Pangram model weights are © Pangram Labs, licensed [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/), non-commercial use only, and are not included in this repo. Slopless is not affiliated with Pangram Labs.
