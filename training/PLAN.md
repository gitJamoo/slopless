# Training plan: Slopless X model (v0)

**Executor:** Claude Code on the RTX 4060 machine. Work phase by phase. Each phase ends with a **gate**: stop, write results to `training/LOG.md`, and report to the user before continuing.

**Goal:** a small (≤ 40 MB), license-clean classifier that tells human-written X posts from AI-written ones, runs on CPU in the browser, and ships inside the extension. The extension already works; it just needs `public/models/slopless-x/` replaced by a real model (see `scripts/export_model.py`).

**Interface the extension expects:**
- A Hugging Face `AutoModelForSequenceClassification`.
- 2 labels in v0: `0 = human`, `1 = ai`. The extension's score is P(ai).
- Input text is passed through `normalizeForModel` (`lib/text.ts`) before it reaches the model.
- Training must use the Python twin `slopdata/normalize.py`, which is tested against `normalize_cases.json`. Never change one without the other.

## Hard rules

- **License-clean training data only.**
  - No tweets in training (X's terms allow sharing IDs only, and users own their text). Real tweets may be used **for evaluation only**, never committed.
  - No Pangram outputs or Open Pangram predictions used as labels.
  - Record every source and its license in `LOG.md`.
- **Generator licenses:** prefer Apache-2.0 open models (Qwen, Mistral, OLMo). Check Llama and Gemma terms before using them. For hosted APIs, quote the terms clause that permits using outputs to train a classifier, or don't use that provider.
- **Data stays out of git:** `training/data/` and `training/runs/` are gitignored. Commit scripts, configs, `LOG.md` and `report/`.
- **Secrets via env vars only.** Never print them.
- **Hosted-model spend cap: $40.** v0 can be done with $0 (open models only).

## Layout

```
training/
  PLAN.md  LOG.md  requirements.txt  normalize_cases.json
  slopdata/   normalize.py (done) · collect.py · generate.py · postprocess.py · split.py
  configs/    prompts.yaml · generators.yaml · train.yaml
  train.py · eval.py
  tests/      test_normalize.py (done)
  data/ runs/ (gitignored)   report/ (committed)
```

Export is `scripts/export_model.py`, which already exists and is tested with a stand-in.

---

## Phase 0: environment (about 1 hour)

1. Record the OS, GPU and VRAM (`nvidia-smi`), RAM and free disk (need about 40 GB) in `LOG.md`.
2. Create a Python 3.11/3.12 venv. Install `pip install -r training/requirements.txt`, plus torch with CUDA from pytorch.org's index.
3. Install **Ollama** (Windows/Linux) or **vLLM** (Linux/WSL2, faster batching) and pull 2–3 generators sized for VRAM. With 8 GB, use 7–8B models at Q4. Set `OLLAMA_NUM_PARALLEL=4`.
4. Run `python training/tests/test_normalize.py` and `npm test`. Both must pass.
5. **Smoke test the whole path end to end with a tiny model:**
   1. Fine-tune Ettin-17M for 50 steps on 200 fake examples.
   2. Export with `scripts/export_model.py`.
   3. `npm run build && npm run e2e`.

   Done before any data work, so pipeline problems surface early.

**Gate 0:** environment table, license table for the planned generators and datasets, smoke-test output.

---

## Phase 1: human data (`collect.py`)

**Target:** about 30k human texts, X-shaped, written before 30 Nov 2022 (the ChatGPT launch).

1. **Sources** (verify license and dates first):
   - `liamdugan/raid` (MIT): human rows, Reddit domain first.
   - `yaful/MAGE` (Apache-2.0): human rows from casual sources (ChangeMyView, ELI5, Yelp).
2. **Reshape to X length.** Split on sentence or paragraph boundaries into 15–280 word chunks, sampled so about 55% are 15–60 words, 30% 60–150, and 15% 150–280. Keep at most 3 chunks per source text.
3. **Strip source-specific markup that X never has:** `EDIT:`, `r/`, `u/`, markdown links and headers, `&gt;` quotes.
4. Apply `normalize_for_model`. Keep English only. Dedupe exact matches and near-duplicates (MinHash, Jaccard ≥ 0.8).
5. **Tag hard human negatives:** formal, list-heavy, motivational or marketing-ish text, plus deliberately casual or lowercase text. These keep the model from learning "polished = AI" or "casual = human". Report the share of each.
6. Write `data/raw/human.parquet` with `id, text, source, words, tags`.

**Gate 1:** counts, length histogram, source mix, 30 random samples.

---

## Phase 2: AI data (`generate.py`, `postprocess.py`), overnight

**Target:** about 30k AI texts, seeded from the Phase 1 human texts so topics match across classes. That forces the model to learn style rather than topic.

### Prompt matrix (`configs/prompts.yaml`)

| Task | Prompt idea | Share |
|---|---|---|
| `fresh_post` | First summarize the seed's topic in one line, then "Write an X post about: {topic}". Don't show the seed itself. | 20% |
| `reply` | "Here's a post: {seed}. Write a reply." Include the generic engagement-bait style. | 20% |
| `quote_take` / `thread_opener` | React to the seed, or open a thread on its topic | 10% |
| `persona` | Founder, crypto, fitness, politics, tech-bro, wholesome, etc. | 10% |
| `polish` | "Improve this post: {seed}" (labelled AI in v0) | 10% |
| **`humanized`** | See Phase 2b | **30%** |

Vary temperature (0.7–1.2), top-p and min-p, length instructions, and persona. Match the human length histogram.

### `generate.py`

- Works with any OpenAI-compatible endpoint (Ollama/vLLM locally; optionally hosted).
- Async with a concurrency limit, retries, and **resumable** JSONL shards.
- Records `id, seed_id, generator, family, task, temperature, text, cost_usd`.
- Enforces the spend cap.

### `postprocess.py`

- Strip preambles ("Here's a tweet:", wrapping quotes, "1/") and apply `normalize_for_model`.
- Enforce the 15–280 word window and dedupe.
- **Shortcut audit (required):** train a quick character n-gram logistic regression and inspect its top 50 features. Anything that's an artifact rather than style means fixing normalization and redoing it. Examples: `<url>` only in human text, hashtags only in AI text, trailing ellipsis, a particular quote style. Also confirm a length-only classifier is near chance within each length bucket. Log before and after.

### `split.py`

- Split **by seed** (a seed and all its derivatives in one split), 80/10/10.
- **Held-out generator:** keep one whole model family out of train and val. That becomes `test_unseen_gen`, the most honest number in the report.
- **Real-tweet eval set** (`data/eval/real_x.parquet`, eval-only, never committed):
  - Human: pre-2022 tweets from a public academic set (e.g. `cardiffnlp/tweet_eval`).
  - AI: fresh generations from the held-out family.

### Phase 2b: AI text written to sound human (the main accuracy lever)

This is where most small detectors fail, so it gets its own budget. A third of the AI data and one extra loop:

1. **Humanizer prompts:**
   - "Write like a real person on X: lowercase is fine, no em dashes, no hashtags, no lists, a typo or two, a strong opinion, a specific detail."
   - Mimic a given human seed's voice (style transfer).
   - "Rewrite this to avoid AI detection."
2. **Two-step rewriting:** generate normally, then have a *different* model rewrite it casually. This mimics the paraphrasing tools people use to disguise AI text.
3. **The same noise on both classes:** random typos, lowercasing, emoji insertion and punctuation removal, applied to human and AI text alike. That way "has typos" and "lowercase" stop meaning "human", and the model learns deeper cues.
4. **Human hard negatives balance it:** polished and listy human posts (Phase 1 tags) keep the model from flagging anything neat.
5. **Red-team loop** (after the first model trains):
   1. Generate about 5k new humanized posts.
   2. Score them with the current model.
   3. Keep the ones it misses (score < threshold).
   4. Add them to training and retrain.
   5. Repeat 2–3 rounds.

   Track the humanized catch rate on a **held-out** humanized set each round. It should rise without the human false-positive rate going up.
6. **Account-level backup:** in the product, many short humanized replies from one account still add up, so the account verdict covers some of what slips past single-post scoring.

**Gate 2:** class, length and task tables, generator mix, shortcut-audit before and after, 30 random AI samples per task.

---

## Phase 3: training (`train.py`, minutes per run)

- **Candidates:** `jhu-clsp/ettin-encoder-17m` (default target), `jhu-clsp/ettin-encoder-32m`, `microsoft/MiniLM-L12-H384-uncased`. All MIT.
- **Settings:** 2 labels, `max_length` 128, bf16, batch 64, learning rate 5e-5 (17M/32M) or 3e-5 (MiniLM), 3 epochs, warmup 6%, weight decay 0.01, eval every half epoch.
- **Model selection:** pick the checkpoint with the best **val TPR at 1% FPR**, not accuracy.
- Save to `runs/<name>/best` in Hugging Face format. Log config, metrics and wall time.
- Run the Phase 2b red-team loop here: train → mine misses → retrain.

**Gate 3:** table of model, size, val AUROC, val TPR at 1% FPR, humanized TPR at 1% FPR, and train time.

---

## Phase 4: evaluation (`eval.py`)

Run on `test`, `test_unseen_gen`, `real_x`, the held-out humanized set, and `nonnative`. The last one is the EditLens repo's `data/nonnative_english.csv`, CC BY-NC-SA, OK for evaluation only.

- **Metrics:** AUROC, **TPR at 1% FPR**, FPR at the shipping threshold, calibration (ECE).
- **Breakdowns:** by length (15–40 / 40–100 / 100–280 words), task and generator.
- **Shipping threshold:** the score that gives ≤ 1% FPR on `real_x` human posts. Put it in `slopless.json` as a recommendation; the extension default is 0.7, so update it if different.
- **Optional comparisons (ask the user first; cost and access):**
  - Open Pangram, for non-commercial evaluation.
  - The Pangram API on a 300-post sample (about $15).
  - Jev on the same sample (about $0.01).
- Write `report/REPORT.md` with tables, a ROC chart, and an honest limitations section.

**Gate 4 targets** (initial; revisit with the user):
- `test_unseen_gen` 40+ words: TPR ≥ 80% at 1% FPR.
- 15–40 words: TPR ≥ 50% at 1% FPR.
- Humanized: TPR ≥ 60% at 1% FPR.
- `nonnative` FPR ≤ 5% at the shipping threshold.

---

## Phase 5: export and ship

1. Run `python scripts/export_model.py --model training/runs/<best>/best --name slopless-x-v0`.
2. **Quantization check.**
   - Run the int8 and fp32 ONNX models over the whole test set. The verdict at the shipping threshold must agree on ≥ 99.5% of posts.
   - If it doesn't, export with `--dtype fp32` (about 68 MB). Note in `LOG.md` that, with the untrained stand-in head, int8 shifted logits by up to about 1.3, so this check matters.
3. Run `npm run build && npm run e2e`. Report latency at 20, 60 and 150 words. The stand-in baseline on a Pi 5 is 25, 37 and 67 ms.
4. Write a model card (`public/models/slopless-x/MODEL_CARD.md`): data sources and licenses, eval summary, intended use, limits.
5. Decide with the user whether model files are committed (about 21 MB, under the MIT license since the data is clean) or attached to GitHub Releases.

**Gate 5:** sizes, quantization agreement, latency table, model card.

---

## Later (not v0)
Three classes (AI-edited), hosted-model generators, teacher distillation, a slop-score head, more sites. See `ROADMAP.md`.
