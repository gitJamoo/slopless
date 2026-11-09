#!/usr/bin/env python3
"""
Convert Open Pangram (EditLens RoBERTa-large) into browser-ready ONNX for Slopless.

The model is gated on Hugging Face. First:
  1. Request access at https://huggingface.co/pangram/editlens_roberta-large
  2. `huggingface-cli login` (or export HF_TOKEN=...)

Then:
  python scripts/convert_model.py                 # q8 only (~360MB, best for CPU/WASM)
  python scripts/convert_model.py --dtypes q8,q4  # also 4-bit for WebGPU
  python scripts/convert_model.py --stand-in      # ungated roberta-large + random head:
                                                  # same speed, meaningless scores (benchmarks only)

Output goes to public/models/editlens-roberta-large/, which the build packs into the
extension. Weights are CC BY-NC-SA 4.0: don't redistribute them commercially.
"""
import argparse
import json
import shutil
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch
from huggingface_hub import snapshot_download
from transformers import AutoConfig, AutoModelForSequenceClassification, AutoTokenizer

ROOT = Path(__file__).resolve().parent.parent
GATED_REPO = "pangram/editlens_roberta-large"
BASE_REPO = "FacebookAI/roberta-large"
TOKENIZER_FILES = ["tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "config.json"]
SAMPLE = "honestly i did not expect the new bus route to change much, but my commute dropped by twenty minutes."


def export_fp32(model, tokenizer, path: Path):
    enc = tokenizer([SAMPLE, SAMPLE + " and more words here"], padding=True, return_tensors="pt")
    with torch.no_grad():
        torch.onnx.export(
            model,
            (enc["input_ids"], enc["attention_mask"]),
            str(path),
            input_names=["input_ids", "attention_mask"],
            output_names=["logits"],
            dynamic_axes={
                "input_ids": {0: "batch", 1: "seq"},
                "attention_mask": {0: "batch", 1: "seq"},
                "logits": {0: "batch"},
            },
            opset_version=17,
            dynamo=False,
        )


def quantize_q8(src: Path, dst: Path):
    from onnxruntime.quantization import QuantType, quantize_dynamic

    quantize_dynamic(str(src), str(dst), weight_type=QuantType.QInt8)


def quantize_q4(src: Path, dst: Path):
    import onnx
    from onnxruntime.quantization.matmul_nbits_quantizer import MatMulNBitsQuantizer

    model = onnx.load(str(src))
    q = MatMulNBitsQuantizer(model, block_size=32, is_symmetric=True)
    q.process()
    q.model.save_model_to_file(str(dst), use_external_data_format=False)


def check(onnx_path: Path, tokenizer, torch_logits: np.ndarray, max_length: int):
    sess = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    enc = tokenizer([SAMPLE], return_tensors="np")
    feeds = {"input_ids": enc["input_ids"].astype(np.int64), "attention_mask": enc["attention_mask"].astype(np.int64)}
    logits = sess.run(None, feeds)[0]
    diff = float(np.abs(logits - torch_logits).max())
    # CPU timing at a realistic post length (~100 words ≈ 128 tokens) and the full length
    timings = {}
    for n in (128, max_length):
        ids = np.full((1, n), 1000, dtype=np.int64)
        ids[0, 0], ids[0, -1] = tokenizer.cls_token_id, tokenizer.sep_token_id
        f = {"input_ids": ids, "attention_mask": np.ones_like(ids)}
        sess.run(None, f)
        t = []
        for _ in range(3):
            t0 = time.perf_counter()
            sess.run(None, f)
            t.append((time.perf_counter() - t0) * 1000)
        timings[n] = round(sorted(t)[1])
    return diff, timings


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dtypes", default="q8", help="comma list of q8,q4")
    ap.add_argument("--stand-in", action="store_true", help="use ungated roberta-large with a random 4-bucket head")
    ap.add_argument("--out", default=str(ROOT / "public/models/editlens-roberta-large"))
    ap.add_argument("--work", default=str(ROOT / "model-src"))
    args = ap.parse_args()
    dtypes = [d.strip() for d in args.dtypes.split(",") if d.strip()]

    out, work = Path(args.out), Path(args.work)
    (out / "onnx").mkdir(parents=True, exist_ok=True)
    work.mkdir(parents=True, exist_ok=True)

    if args.stand_in:
        print(f"STAND-IN: {BASE_REPO} with an untrained 4-bucket head. Scores are meaningless.")
        src = snapshot_download(BASE_REPO, allow_patterns=["*.json", "*.txt", "model.safetensors"])
        config = AutoConfig.from_pretrained(src, num_labels=4)
        model = AutoModelForSequenceClassification.from_pretrained(src, config=config)
    else:
        src = snapshot_download(GATED_REPO)  # needs accepted terms + HF token
        model = AutoModelForSequenceClassification.from_pretrained(src)
    model.eval()
    tokenizer = AutoTokenizer.from_pretrained(src)
    n_buckets = model.config.num_labels
    max_length = 512

    with torch.no_grad():
        enc = tokenizer([SAMPLE], return_tensors="pt")
        torch_logits = model(**enc).logits.numpy()

    fp32 = work / "model.onnx"
    print("exporting fp32 ONNX…")
    export_fp32(model, tokenizer, fp32)

    for d in dtypes:
        dst = out / "onnx" / {"q8": "model_quantized.onnx", "q4": "model_q4.onnx"}[d]
        print(f"quantizing {d}…")
        {"q8": quantize_q8, "q4": quantize_q4}[d](fp32, dst)
        diff, t = check(dst, tokenizer, torch_logits, max_length)
        mb = dst.stat().st_size / 1e6
        print(f"  {dst.name}: {mb:.0f} MB, max |Δlogit| vs PyTorch {diff:.3f}, CPU (onnxruntime native) "
              + ", ".join(f"{k} tok {v} ms" for k, v in t.items()))

    tokenizer.save_pretrained(work / "tok")
    model.config.save_pretrained(work / "tok")
    for f in TOKENIZER_FILES:
        p = work / "tok" / f
        if p.exists():
            shutil.copy(p, out / f)

    meta = {"dtypes": dtypes, "n_buckets": n_buckets, "max_length": max_length, "stand_in": args.stand_in,
            "source": BASE_REPO if args.stand_in else GATED_REPO, "license": "CC BY-NC-SA 4.0"}
    (out / "slopless.json").write_text(json.dumps(meta, indent=2))
    print(f"done -> {out}\nnow run: npm run build")


if __name__ == "__main__":
    main()
