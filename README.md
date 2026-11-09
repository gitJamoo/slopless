# Slopless

A browser extension that spots AI-generated posts in your feed and **flags** or **hides** them, usually before you've scrolled to them.

Detection uses a **small classifier trained for this one job** (~17 MB). It runs **on your device, on the CPU**: no server, no account, no API key, no network requests. Starting with X; more sites are on the [roadmap](ROADMAP.md).

| Mode | What happens to a likely-AI post |
|---|---|
| Off | Nothing. |
| Flag | A small badge: `Likely AI · 91%`, or `Account: mostly AI · 6 posts`. |
| Hide | The post collapses to "Hidden by Slopless · Show". |

> **Status:** the extension works end to end, but the shipped model is a *stand-in* (the right architecture with an untrained head), so its verdicts are random. The real model is being trained; see [`training/PLAN.md`](training/PLAN.md).

## How it works

```
content script (per-site adapter, lib/adapters.ts)
  ├─ MutationObserver + IntersectionObserver (1200px look-ahead): scores posts before you reach them
  ├─ blurs a post's text until its verdict arrives (fails open after 10 s)
  ├─ posts ≥ 15 words get their own verdict
  └─ account verdicts: on X, every post ≥ 5 words counts toward its author. When ≥ 5 of an
     author's posts average AI, all of that author's posts get flagged, even short replies.
     Kept in memory for the session only.
        │  runtime message (text)
        ▼
background worker
  ├─ cache: SHA-256(text) → score (the post text itself is never stored)
  └─ micro-batching (up to 8 posts or 30 ms) → one model call
        ▼
offscreen.html (Chrome offscreen document; hidden iframe on Firefox/Safari)
  └─ transformers.js + ONNX Runtime Web (CPU-only WASM, 2 threads)
     → closes itself after 3 idle minutes, which frees all its memory
```

The text normalization (`normalizeForModel` in `lib/text.ts`) is mirrored in Python (`training/slopdata/normalize.py`). Both are tested against one shared fixture, so the model sees text the same way in training and in the browser.

## Measured performance

Raspberry Pi 5, headless Chromium, int8, 2 threads. A Pi 5 is roughly as fast as a mid-range phone CPU or an old laptop.

| Model | Size | 20 words | 60 words | 150 words | Load |
|---|---|---|---|---|---|
| **Ettin-17M** (the target architecture) | 17 MB | 25 ms | 37 ms | 67 ms | 1.3 s |
| RoBERTa-large (the earlier prototype) | 357 MB | — | ~1,700 ms (100 words) | ~4,000 ms (250 words) | 4.6 s |

The whole extension is 35.5 MB: model 17 MB, CPU runtime 14 MB, tokenizer 3.6 MB. It never uses the GPU.

## Setup

```bash
npm install                 # also copies ONNX Runtime's CPU WASM into public/ort
```

### Get a model

The extension loads whatever is in `public/models/slopless-x/`. To make one you need Python with `torch transformers onnx onnxruntime onnxscript` (see `training/requirements.txt`).

```bash
# stand-in for development: real size and speed, random verdicts
python scripts/export_model.py --model jhu-clsp/ettin-encoder-17m --stand-in

# a trained model (see training/PLAN.md)
python scripts/export_model.py --model training/runs/<run>/best
```

### Build and load

```bash
npm run build               # → .output/chrome-mv3   (npm run build:firefox → .output/firefox-mv3)
```

- **Chrome, Edge, Brave, Arc:** go to `chrome://extensions`, turn on Developer mode, click "Load unpacked", and pick `.output/chrome-mv3`.
- **Firefox:** go to `about:debugging`, click "Load Temporary Add-on", and pick `.output/firefox-mv3/manifest.json`.

### Try it without an X login

```bash
npm run demo                # http://localhost:5179: a fake feed with human posts, AI posts, and a reply bot
```

## Development

```bash
npm run dev                 # Chrome with hot reload
npm test                    # unit tests (JS + the Python normalization twin)
npm run typecheck
npm run build && npm run e2e -- --shots shots    # headless Chromium end to end, with screenshots
```

## Honest limits

- **Short posts are hard.** A single 10-word reply carries little signal. That's why account-level verdicts exist.
- **False positives are the failure that matters.** The default threshold is tuned for at most 1% false positives on human posts, so the extension misses some AI posts rather than accusing people. The default mode is Flag, and Hide is always one click from the original.
- **AI text prompted to "sound human"** is the hardest case. The training plan targets it directly with adversarial data, but no small model will catch all of it.
- **Selectors drift.** Sites change their HTML. Each site is a small adapter in `lib/adapters.ts`.

## Related

The `prototype-pangram` git tag holds an earlier version that also supported Pangram's API and their open-weights model (Open Pangram, CC BY-NC-SA). Bringing back "bring your own Pangram key" is on the roadmap.

## License

MIT. See [LICENSE](LICENSE). Not affiliated with X, Pangram Labs, or any platform it runs on.
