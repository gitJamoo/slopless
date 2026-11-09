#!/usr/bin/env python3
"""
Export a Hugging Face sequence classifier to the browser-ready folder Slopless loads:
public/models/slopless-x/{config.json, tokenizer files, onnx/model_quantized.onnx, slopless.json}

  # a trained model (output of training/train.py):
  python scripts/export_model.py --model training/runs/ettin17m-v0/best

  # a stand-in for development: real architecture + size + speed, untrained head, random verdicts
  python scripts/export_model.py --model jhu-clsp/ettin-encoder-17m --stand-in

Needs: torch, transformers, onnx, onnxruntime, onnxscript (see training/README or PLAN.md).
"""
import argparse
import json
import shutil
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch
from transformers import AutoConfig, AutoModelForSequenceClassification, AutoTokenizer

ROOT = Path(__file__).resolve().parent.parent
SAMPLES = [
    "honestly did not expect the new bus route to change much, but my commute dropped by twenty minutes.",
    "In today's fast-paced world, consistency is the cornerstone of meaningful growth. 🚀 Agree?",
]


def export_fp32(model, tokenizer, path: Path, opset: int):
    enc = tokenizer(SAMPLES, padding=True, return_tensors="pt")
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
            opset_version=opset,
            dynamo=False,
        )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True, help="HF repo id or local checkpoint dir")
    ap.add_argument("--stand-in", action="store_true", help="attach an untrained classification head")
    ap.add_argument("--num-labels", type=int, default=2, help="labels for --stand-in")
    ap.add_argument("--max-length", type=int, default=512)
    ap.add_argument("--name", default=None, help="display name (default: derived from --model)")
    ap.add_argument("--out", default=str(ROOT / "public/models/slopless-x"))
    ap.add_argument("--work", default=str(ROOT / "model-src"))
    ap.add_argument("--opset", type=int, default=17)
    ap.add_argument("--dtype", choices=["q8", "fp32"], default="q8",
                    help="q8 = dynamic int8 (~4x smaller); fp32 if int8 changes verdicts too often")
    args = ap.parse_args()

    out, work = Path(args.out), Path(args.work)
    if out.exists():
        shutil.rmtree(out)
    (out / "onnx").mkdir(parents=True)
    work.mkdir(parents=True, exist_ok=True)

    if args.stand_in:
        print(f"STAND-IN: {args.model} with an untrained {args.num_labels}-label head. Verdicts are random.")
        config = AutoConfig.from_pretrained(args.model, num_labels=args.num_labels)
        model = AutoModelForSequenceClassification.from_pretrained(args.model, config=config)
    else:
        model = AutoModelForSequenceClassification.from_pretrained(args.model)
    model.eval()
    tokenizer = AutoTokenizer.from_pretrained(args.model)

    with torch.no_grad():
        ref = model(**tokenizer(SAMPLES, padding=True, return_tensors="pt")).logits.numpy()

    fp32 = work / "model.onnx"
    print("exporting fp32 ONNX…")
    export_fp32(model, tokenizer, fp32, args.opset)

    from onnxruntime.quantization import QuantType, quantize_dynamic

    if args.dtype == "q8":
        q8 = out / "onnx" / "model_quantized.onnx"
        print("quantizing int8…")
        quantize_dynamic(str(fp32), str(q8), weight_type=QuantType.QInt8)
    else:
        q8 = out / "onnx" / "model.onnx"
        shutil.copy(fp32, q8)

    # parity + native CPU timing
    sess = ort.InferenceSession(str(q8), providers=["CPUExecutionProvider"])
    enc = tokenizer(SAMPLES, padding=True, return_tensors="np")
    feeds = {k: enc[k].astype(np.int64) for k in ("input_ids", "attention_mask")}
    logits = sess.run(None, feeds)[0]
    diff = float(np.abs(logits - ref).max())
    agree = bool((logits.argmax(1) == ref.argmax(1)).all())
    t = []
    for _ in range(5):
        t0 = time.perf_counter()
        sess.run(None, {k: v[:1] for k, v in feeds.items()})
        t.append((time.perf_counter() - t0) * 1000)
    size = q8.stat().st_size

    tokenizer.save_pretrained(work / "tok")
    model.config.save_pretrained(work / "tok")
    for f in (work / "tok").iterdir():
        if f.suffix in (".json", ".txt", ".model"):
            shutil.copy(f, out / f.name)

    meta = {
        "name": args.name or Path(args.model.rstrip("/")).name,
        "source": args.model,
        "stand_in": args.stand_in,
        "dtype": args.dtype,
        "n_buckets": model.config.num_labels,
        "max_length": args.max_length,
        "bytes": size,
        "exported": time.strftime("%Y-%m-%d"),
    }
    (out / "slopless.json").write_text(json.dumps(meta, indent=2))
    print(
        f"done -> {out}\n  int8 size {size / 1e6:.1f} MB · max |Δlogit| vs PyTorch {diff:.4f} · "
        f"argmax agrees: {agree} · native CPU ~{sorted(t)[2]:.0f} ms/post\n  next: npm run build"
    )


if __name__ == "__main__":
    main()
