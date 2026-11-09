# Training plan: a small, license-clean AI-text detector for X

**Executor:** Claude Code on the RTX 4060 machine. Work phase by phase. Each phase ends with a **gate**. Stop at every gate, write results into `training/LOG.md`, and report to the user before continuing.

## Why this exists

Slopless (the browser extension in this repo) needs an on-device detector that:

1. **Can be published.** Open Pangram (`pangram/editlens_roberta-large`) is gated and CC BY-NC-SA, so it can't ship in a public extension. Everything in this model must be license-clean.
2. **Is light.** Target ≤ 40 MB int8, ≤ 100 MB RAM, CPU-only, ≤ 200 ms per 60-word post on a Raspberry Pi 5 in the browser. The current RoBERTa-large stand-in is 360 MB and takes 1.7 s per 100-word post on the Pi (see `README.md`).
3. **Works on X first.** Posts are short (15–280 words), and replies are a major slop vector. LinkedIn, Reddit, Slack and Gmail come later.

Output: three classes, `human`, `ai_edited` and `ai_generated`. Score = expected class / 2, in [0, 1]. This keeps the same interface as the extension's current `bucketScore`, so `lib/engine.ts` barely changes.

## Hard rules

- **No tweets in training data.** Tweet datasets aren't license-clean: X's terms allow sharing IDs only, and users own their text. Real tweets may be used **only in the held-out evaluation set**, never committed, and the write-up must say so.
- **No Pangram outputs as labels.** Training on Pangram API or Open Pangram predictions (distillation) is forbidden. Pangram may be used only to *evaluate* against.
- **Generators must be license-checked** before use (Phase 0).
- **Keep data out of git.** Everything under `training/data/` is gitignored. Commit scripts, configs, `LOG.md`, and the eval report.
- **Secrets via env vars only:** `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `HF_TOKEN`, `PANGRAM_API_KEY`. Never print or commit them.
- **Hosted-model spend cap: $40 total.** `generate.py` enforces it and logs running cost.

## Layout to create

```
training/
  PLAN.md            this file
  LOG.md             running log: decisions, numbers, gate results
  pyproject.toml     uv-managed env
  configs/           yaml per phase (generators, prompt matrix, train runs)
  slopdata/          python package
    collect.py       Phase 1
    generate.py      Phase 2
    postprocess.py   Phase 2 (normalize, filter, dedupe, shortcut audit)
    split.py         Phase 2
  train.py           Phase 3
  eval.py            Phase 4
  export.py          Phase 5
  data/              gitignored: raw/, gen/, final/, eval/
  runs/              gitignored: checkpoints
  report/            committed: eval report + charts
```

---

## Phase 0: environment and verification (about 1 hour)

1. **Machine facts.** Record the OS, GPU model, VRAM (`nvidia-smi`), CUDA version, RAM and free disk in `LOG.md`. Need about 60 GB free.
2. **Python environment.** Python 3.11 or 3.12 with `uv`. Install torch with CUDA, `transformers`, `datasets`, `accelerate`, `evaluate`, `scikit-learn`, `onnx`, `onnxruntime`, `datasketch` (MinHash), `ftfy`, `pyyaml`, `matplotlib`.
3. **Local generation server.**
   - Linux or WSL2: **vLLM** (fast batched generation).
   - Native Windows: **llama.cpp server** or **Ollama**.
   - Either way it must expose an OpenAI-compatible `/v1/chat/completions` endpoint.
   - If VRAM is 8 GB, use 7–8B models at 4-bit (AWQ/GGUF Q4) with a context ≤ 4k.
4. **Re-verify licenses** and record a table in `LOG.md`.

   | Item | Expected | Check |
   |---|---|---|
   | `liamdugan/raid` | MIT | HF card. Confirm the human texts predate Nov 2022. |
   | `yaful/MAGE` | Apache-2.0 | HF card. Confirm human sources and dates. |
   | `jhu-clsp/ettin-encoder-17m`, `-32m` | MIT | HF card |
   | `microsoft/MiniLM-L12-H384-uncased` | MIT | HF card |
   | `microsoft/deberta-v3-large` (teacher, optional) | MIT | HF card |
   | Local generators | Prefer Apache-2.0 (Qwen, Mistral, OLMo) | Read each model license. Note any output-use restrictions (Llama and Gemma have custom terms). |
   | Hosted generators | — | Read OpenAI, Anthropic and Google terms on using outputs to train a *classifier*. Quote the relevant clause. If any is unclear, leave that provider out and tell the user. |

5. **Export smoke test.** Load `jhu-clsp/ettin-encoder-17m` with a random 3-label head, export to ONNX, quantize to int8, and confirm the result loads in transformers.js. The repo already depends on `@huggingface/transformers`, and its web build includes `ModernBertForSequenceClassification`. Do this **before** investing in data.

**Gate 0:** report the environment table, the license table (with any provider dropped), and the smoke-test result.

---

## Phase 1: human data (`collect.py`, about half a day)

**Target:** about 40k human texts, X-shaped, all written before the 30 Nov 2022 ChatGPT launch.

1. Pull human-labelled rows from **RAID** (Reddit domain first, then reviews and other conversational domains) and **MAGE** (ChangeMyView, ELI5, Yelp, and similar casual sources). Drop AI rows; old-model AI rows may optionally be kept separately as extra `ai_generated` data tagged `legacy_gen`.
2. **Reshape to X length.** Split long texts on sentence or paragraph boundaries into chunks of 15–280 words. Sample the chunk lengths to match an X-like distribution: about 60% of chunks 15–60 words, 30% 60–150, 10% 150–280. Keep at most 3 chunks per source text.
3. **Normalize both classes identically.** This step is also applied to AI text in Phase 2, so it lives in `postprocess.py`.
   - Run `ftfy`, NFKC, straight-vs-curly quote unification, and whitespace collapse.
   - Replace URLs with `<url>`, @mentions with `@user`, and emails with `<email>`.
   - Strip Reddit-isms that X never has: `EDIT:`, `/r/`, `u/`, markdown links and headings, `&gt;` quotes.
4. **Filter.** Keep English only (a fastText or `langid` check) and drop texts that are mostly non-text (link dumps).
5. **Dedupe** exact matches and near-duplicates (MinHash, Jaccard ≥ 0.8).
6. **Hard human negatives.** Tag rows likely to fool a detector: formal, list-heavy, motivational or marketing-ish (a quick heuristic, e.g. a list or "lessons" structure). Report what fraction we have. Human hustle-post data is a known gap. Note it, but don't scrape LinkedIn.
7. Save `data/raw/human.parquet` with `id, text, source, source_domain, words, hard_negative`.

**Gate 1:** row counts, length histogram, source mix, and 30 random samples pasted into `LOG.md` for the user to eyeball.

---

## Phase 2: AI data (`generate.py`, `postprocess.py`, `split.py`, overnight)

**Target:** about 25k `ai_generated` and about 12k `ai_edited`, seeded from the Phase 1 human texts.

### Prompt matrix (`configs/prompts.yaml`)

Seed each generation from a human text, so topics match across classes. That forces the model to learn style rather than topic.

| Task | Label | Prompt idea |
|---|---|---|
| `fresh_post` | ai_generated | First get a one-line topic summary of the seed, then "Write an X post about: {topic}". Don't show the generator the seed text itself. |
| `reply` | ai_generated | "Here's a post: {seed}. Write a reply." Include the generic engagement-bait reply style. |
| `quote_take` | ai_generated | "Write a quote-post reacting to: {seed}" |
| `thread_opener` | ai_generated | "Write the first post of a thread about {topic}" |
| `humanized` | ai_generated | Any of the above plus "sound casual, lowercase ok, no em dashes, no hashtags, maybe a typo". **This is critical.** |
| `persona` | ai_generated | Founder, crypto, fitness, politics, tech-bro, wholesome… |
| `polish` | ai_edited | "Improve this post: {seed}" |
| `light_edit` | ai_edited | "Fix grammar only: {seed}". Keep it only if the output differs from the seed by more than a trivial amount (normalized edit distance > 0.05); otherwise drop it. |

Vary temperature (0.7–1.1) and length instructions, and target the same length histogram as Phase 1.

### Generators (`configs/generators.yaml`)

- **Local (free, most of the volume):** 3–5 families, e.g. Qwen 7–8B, Mistral 7B or Nemo, OLMo 7B, plus Llama or Gemma only if Phase 0 cleared their licenses.
- **Hosted (≤ $40, about 15–25% of AI rows):** the cheapest current small model from each provider that cleared Phase 0. Real X slop mostly comes from ChatGPT, Claude and Gemini, so these matter most for **evaluation**.

### `generate.py` requirements

- Takes any OpenAI-compatible base URL, plus native SDKs for the hosted providers if simpler.
- Async with a concurrency limit, retries with backoff, and **resumable**: it writes JSONL shards and skips ids already done.
- Records `id, seed_id, generator, family, task, label, temperature, prompt_hash, text, cost_usd`.
- Enforces the spend cap and stops cleanly when it's hit.

### `postprocess.py`

- Strip preambles and wrappers ("Here's a tweet:", surrounding quotes, "Tweet 1/"), apply the same normalization as Phase 1, enforce the length window, and dedupe.
- **Shortcut audit, required.** Train a quick bag-of-words / char-n-gram logistic regression for human vs AI and list its top 50 features. If any feature is an artifact rather than style, fix normalization and rerun. Examples of artifacts: `<url>` appearing only in human text, emoji only in AI text, trailing hashtags, curly quotes, length alone. Also check that a length-only classifier is near chance within each length bucket. Record before and after in `LOG.md`.

### `split.py`

- Split **by seed**: a human text and all its AI derivatives go in the same split, so topics don't leak.
- Train / val / test = 80 / 10 / 10.
- **Held-out generator test:** pick one local family and one hosted provider and exclude them from train and val entirely. They become `test_unseen_gen`. This is the most important number in the report.
- **Real-tweet eval set** (`data/eval/real_x.parquet`), eval-only and never committed:
  - Human: a few thousand pre-2022 tweets from a public academic set (e.g. `cardiffnlp/tweet_eval`).
  - AI: freshly generated X posts from the held-out generators.
  - This measures how well the Reddit-trained model handles real X text.
- **Non-native English eval:** the EditLens repo has `data/nonnative_english.csv` (CC BY-NC-SA, OK for non-commercial evaluation; not for training). Use it to measure false positives against Pangram's published numbers (about 10% FPR for the open RoBERTa model, 0% for Pangram's production model).

**Gate 2:** class and length tables, generator mix, cost spent, shortcut-audit results, and 30 random AI samples per task.

---

## Phase 3: training (`train.py`, hours)

**Candidates:** `ettin-encoder-17m`, `ettin-encoder-32m`, `MiniLM-L12-H384-uncased`.

**Defaults:**
- Sequence classification with 3 labels, `max_length` 128 (X is short; also try 256 for the best candidate).
- bf16, batch 64 (use gradient accumulation if VRAM-bound).
- Learning rate 5e-5 for 17M/32M and 3e-5 for MiniLM, 3 epochs, warmup 6%, weight decay 0.01, eval every half epoch.
- Class weights to balance classes.
- Select the best checkpoint by **val TPR at 1% FPR**, not accuracy.

**Optional teacher, only if the small models fall short of the gate:**
1. Train `deberta-v3-large` on the same data (batch 8 with accumulation at length 128, which should fit in 8 GB with bf16 and gradient checkpointing).
2. Distill into the best small model: KL on teacher soft labels at temperature 2, plus 0.5 × cross-entropy on the true labels.

The teacher is our own model, so this is license-clean.

Log every run (config, metrics, wall time) to `LOG.md` and `runs/<name>/`.

**Gate 3:** comparison table with model, size, val AUROC, val TPR at 1% FPR, and train time.

---

## Phase 4: evaluation (`eval.py`, about half a day)

For the best 1–2 models, compute these on `test`, `test_unseen_gen`, `real_x` and `nonnative`:

- AUROC, **TPR at 1% FPR**, FPR at the threshold the extension will ship with, and calibration (ECE).
- Breakdowns by length bucket (15–40, 40–100, 100–280 words), by task (especially `humanized` and `reply`), and by generator.
- **Comparisons on the same 300-post sample** (stratified by length and generator):
  - Open Pangram RoBERTa-large. Its CC BY-NC-SA license allows non-commercial evaluation, and access needs `HF_TOKEN` with accepted terms. Use the converter in `scripts/convert_model.py` or the EditLens inference script.
  - The Pangram API (`pangram-4`). This costs about $15–25, so **ask the user before spending**.
- **Threshold recommendation:** choose the threshold that gives ≤ 1% FPR on `real_x` human posts, plus the band of uncertain scores to send to Pangram in Hybrid mode.

Write `report/REPORT.md` with:
- the tables,
- a size-vs-accuracy chart (ours vs Open Pangram vs Pangram API),
- a ROC chart,
- the honest-limitations section: Reddit-trained, short-text limits, non-native false positives, generator drift.

**Gate 4 targets** (initial; adjust with the user after seeing the data):
- `test_unseen_gen`, 40+ words: TPR ≥ 80% at 1% FPR.
- 15–40 words: TPR ≥ 50% at 1% FPR. Short text is hard, and the account-level aggregation in the extension is there to cover it.
- `nonnative` FPR at the shipping threshold ≤ 5%. Must beat Open Pangram's ~10%.
- int8 size ≤ 40 MB.

---

## Phase 5: export (`export.py`, about 1 hour)

1. Export the best model to ONNX at opset 17 with dynamic batch and sequence axes.
2. Dynamic-quantize to int8 (`model_quantized.onnx`). Also try `q4` only if a WebGPU path is wanted later; CPU stays q8.
3. Write a transformers.js-ready folder at `public/models/slopsense-x-v1/`:
   - `config.json`, the tokenizer files, `onnx/model_quantized.onnx`,
   - `slopless.json` containing `{ "dtypes": ["q8"], "n_buckets": 3, "max_length": 128 }`,
   - a `MODEL_CARD.md` with data, license, eval summary and intended use.
4. **Parity check:** the PyTorch vs ONNX int8 max logit difference must be small, and argmax must agree on ≥ 99.5% of the test set.
5. **Browser latency check:** build the extension and run `node scripts/e2e.mjs` (headless Chromium). Report median ms per post for 20, 60 and 150 words. Target ≤ 200 ms at 60 words on the Pi and much less on the 4060 machine's CPU.

**Gate 5:** sizes, parity, and latency table.

---

## Phase 6: extension integration (back in the main repo)

These can start in parallel on the Pi; they don't depend on the model.

- **Resource limits:**
  - Ship the CPU-only ONNX Runtime build (`ort-wasm-simd-threaded.wasm`, 14 MB instead of 27 MB). Make WebGPU an opt-in setting.
  - Use 2 threads.
  - Lazy-load the model, and close the offscreen document after 3 minutes idle.
  - Score only posts within about one screen of the viewport, and pause while the tab is hidden.
  - Show a memory and latency readout in the popup.
- **Model swap:** set `MODEL_ID` to `slopsense-x-v1`, support `n_buckets` = 3, and set the X adapter's minimum to 15 words with the threshold from Phase 4.
- **Account aggregation (X):** keep a per-session, in-memory map from `@handle` to recent scores. Once there are ≥ 5 posts and the mean is ≥ threshold, show an "account posts mostly AI" chip. Never persist it.
- **Keep the large model as an extra:** Open Pangram stays an opt-in "accurate mode" for users who convert the weights themselves (`scripts/convert_model.py`), as now.

---

## Open questions for the user (don't block on these; note them in LOG.md)

- Product name: Slopless vs SlopSense (rename pending).
- Whether to email Pangram about permission to offer Open Pangram as an official optional download.
- The Pangram API comparison spend (about $15–25) needs approval in Phase 4.
