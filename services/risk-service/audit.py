#!/usr/bin/env python3
"""
Audit a traversal sample without training.

Usage:
    python audit.py traversals.jsonl [--model models/risk.joblib]

Reports:
- Feature distributions (to spot outliers / off-distribution)
- If a model is given: implied flag rate on the sample
- Contamination sanity check: if flag rate >> --contamination, the sample isn't routine
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from collections import Counter
from pathlib import Path
from typing import Any

import joblib
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.features import FEATURE_NAMES, build_features
from app.model import ModelHolder

log = logging.getLogger("audit")


def main() -> int:
    parser = argparse.ArgumentParser(description="Audit a traversal sample.")
    parser.add_argument("input", type=Path, help="JSONL of traversal contexts")
    parser.add_argument(
        "--model", type=Path, help="Optional fitted model to score the sample"
    )
    parser.add_argument(
        "--contamination",
        type=float,
        default=0.05,
        help="Expected anomaly rate (default 5%%)",
    )
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    if not args.input.exists():
        raise SystemExit(f"Not found: {args.input}")

    rows = []
    with args.input.open("r", encoding="utf-8") as f:
        for i, line in enumerate(f, 1):
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError as exc:
                raise SystemExit(f"{args.input}:{i}: invalid JSON: {exc}") from exc

    if not rows:
        raise SystemExit("No rows read")

    # Build feature matrix
    matrix = np.asarray([build_features(r) for r in rows], dtype=float)
    n, d = matrix.shape
    log.info("Sample: %d traversals x %d features", n, d)

    # Feature stats
    print("\n=== FEATURE DISTRIBUTIONS ===")
    for i, name in enumerate(FEATURE_NAMES):
        col = matrix[:, i]
        finite = col[np.isfinite(col)]
        if finite.size == 0:
            print(f"  {name}: ALL NON-FINITE")
            continue
        p05, p50, p95 = np.percentile(finite, [5, 50, 95])
        zeros = float((finite == 0).mean())
        print(
            f"  {name:24s}  median={p50:8.3f}  p05={p05:8.3f}  p95={p95:8.3f}  zero={zeros:.0%}"
        )

    # Label/profile summary
    label_counts = Counter()
    for r in rows:
        for lbl in r.get("labels", []):
            kind = str(lbl.get("kind", "")).lower()
            if kind:
                label_counts[kind] += 1
    if label_counts:
        print("\n=== LABEL COUNTS ===")
        for k, v in label_counts.most_common():
            print(f"  {k}: {v}")

    # Model scoring if provided
    if args.model:
        print(f"\n=== MODEL SCORING ({args.model}) ===")
        holder = ModelHolder(str(args.model))
        holder.load()
        if not holder.ready:
            print("Model not ready (unfitted).")
        else:
            scores = [holder.score(r) for r in rows]
            scored = [s for s in scores if s is not None]
            if scored:
                flags = sum(1 for s in scored if s >= 50)
                print(f"  Ready: {holder.ready}, version={holder.version}")
                print(f"  Scores: n={len(scored)}  mean={np.mean(scored):.1f}  median={np.median(scored):.1f}")
                print(f"  Flag rate (score>=50): {flags}/{len(scored)} = {100*flags/len(scored):.1f}%")
                if flags / len(scored) > args.contamination * 3:
                    print(
                        f"  WARNING: flag rate {100*flags/len(scored):.1f}% >> expected {100*args.contamination:.1f}%."
                    )
                    print("  This sample likely contains non-routine traffic.")
            else:
                print("  No finite scores produced.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())