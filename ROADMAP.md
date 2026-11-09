# Roadmap

## Now: v0 on X
- [x] Extension: Off / Flag / Hide, blur-until-checked, account verdicts, CPU-only engine with idle unload
- [x] Export pipeline and a stand-in model (Ettin-17M: 37 ms per 60-word post on a Raspberry Pi 5)
- [ ] Train the v0 model ([`training/PLAN.md`](training/PLAN.md))
- [ ] Publish the eval report: catch rate at 1% false positives, held-out generators, humanized text, non-native English
- [ ] Ship to the Chrome Web Store and Firefox Add-ons, with a privacy policy page

## Accuracy
- [ ] **Humanized AI text:** adversarial generation plus a red-team loop. Generate text that evades the current model, retrain, repeat. See PLAN Phase 2b.
- [ ] More generator families: hosted models (ChatGPT, Claude, Gemini) and newer open models
- [ ] Three classes (human / AI-edited / AI-generated)
- [ ] Teacher → student distillation from a larger model we train ourselves
- [ ] Optional "that's wrong" button: on-device only, used to tune your own threshold; nothing uploaded
- [ ] Retrain every few months as new LLMs ship (scripted, reproducible)

## More sites
Each site = an adapter in `lib/adapters.ts` + a `matches` pattern, plus training data in that site's style.
- [ ] **LinkedIn:** the slop epicenter. Long posts, so the model can be very accurate. Needs human hard negatives (pre-2022 corporate and motivational posts).
- [ ] **Reddit:** the training data is already Reddit-like; mostly adapter work (new Reddit uses shadow DOM, old Reddit is plain HTML).
- [ ] **Gmail:** score the open email body; flag AI-written cold outreach. Gmail's DOM is obfuscated and changes often, so it needs a robust adapter. Must stay on-device (email is sensitive).
- [ ] **Slack:** works in Slack's web client (`app.slack.com`), not the desktop app. Messages are short, so lean on per-author verdicts.
- [ ] **Catch-all:** a "check this page" button plus an opt-in generic adapter that finds text blocks (paragraphs ≥ N words) on any site. Needs `activeTab` / optional host permissions so it's never on by default.

## Classifier experiments ("noodling")
- [ ] **Slop score** as a second output, separate from "AI-written": empty, generic, engagement-bait writing, which people also write. Label it with an open Jev-style classifier on the 4060 (Kev-9B or Clef-Flash, Apache-2.0), then train a small head.
- [ ] Compare backbones: Ettin-17M / 32M, MiniLM-L12, DeBERTa-v3-xsmall
- [ ] Cheap stylometric features (em dashes, list structure, emoji bullets) as extra inputs, if they add accuracy beyond the encoder
- [ ] Benchmark against Open Pangram, the Pangram API, and Jev on the same test set (evaluation only)

## Optional power-ups (always opt-in, clearly labeled as off-device)
- [ ] **Bring your own Pangram key:** cloud check for posts the local model is unsure about (code exists at tag `prototype-pangram`)
- [ ] **Local GPU mode:** point the extension at a local classifier server (e.g. Kev-9B on your own GPU)
- [ ] Safari (macOS/iOS) packaging via Xcode's web-extension converter
