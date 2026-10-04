"""
Fit the advisory model.

    python train.py --input traversals.jsonl --out models/risk.joblib

Input is JSONL, one traversal context per line, shaped like ScoreRequest:

    {"hopIntervals": [12, 40], "consolidationRatio": 0.7, "counterpartyCount": 14,
     "totalValueUsd": 250000, "bridgeCrossings": 1,
     "labels": [{"kind": "exchange", "name": "Binance", "source": "sahyog",
                 "confidence": "high"}], "analystNotes": []}

What this needs from you
------------------------
A sample of **routine** traversals — activity that turned out to be unremarkable.
The model learns the shape of normal and scores distance from it. It is therefore
biased by the sample: if the rows you export are mostly suspicious cases, "normal"
becomes "suspicious" and every result inverts. Sample deliberately.

Note on labels: this system has no outcome labels. A case status records which
workflow stage a case is in, not whether it turned out to be criminal, so there
is nothing here to fit a supervised model against. That is why the model is
unsupervised. If you later accumulate analyst-reviewed outcomes, a supervised
model on those labels would be strictly more informative than this one.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

import joblib
import numpy as np
from sklearn.ensemble import IsolationForest
from sklearn.model_selection import KFold
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import RobustScaler

sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.features import FEATURE_NAMES, build_features  # noqa: E402

log = logging.getLogger("train")

# Below this, a fitted forest is not meaningful and would emit confident-looking
# scores from noise.
MIN_ROWS = 50

# Stored margins per artifact; enough for a smooth percentile, small enough that
# the joblib file stays reasonable.
MAX_STORED_MARGINS = 2048


def build_pipeline(contamination: float, seed: int) -> Pipeline:
    """
    RobustScaler rather than StandardScaler: traversal features are heavily
    right-skewed, and one whale transaction would otherwise set the scale for
    everything else.
    """
    return Pipeline(
        [
            ("scaler", RobustScaler(quantile_range=(25.0, 75.0))),
            (
                "model",
                IsolationForest(
                    n_estimators=300,
                    contamination=contamination,
                    max_samples="auto",
                    random_state=seed,
                    n_jobs=-1,
                ),
            ),
        ]
    )


def out_of_fold_margins(matrix: np.ndarray, contamination: float, seed: int, folds: int) -> np.ndarray:
    """
    Margins for every training row, each produced by a model that did not train
    on that row.

    In-sample margins are optimistic: the forest has already fit the row it is
    scoring, so it reads as more typical than it is. Ranking unseen traffic
    against in-sample margins shifts the whole distribution upward and inflates
    the false-positive rate — measured here at ~61% of held-out routine traffic
    scoring above 50. K-fold removes that bias.
    """
    splitter = KFold(n_splits=folds, shuffle=True, random_state=seed)
    margins = np.empty(matrix.shape[0], dtype=float)
    for train_idx, holdout_idx in splitter.split(matrix):
        fold = build_pipeline(contamination, seed)
        fold.fit(matrix[train_idx])
        margins[holdout_idx] = fold.decision_function(matrix[holdout_idx])
    return margins


def read_rows(path: Path) -> Iterator[dict[str, Any]]:
    with path.open("r", encoding="utf-8") as handle:
        for lineno, line in enumerate(handle, start=1):
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError as exc:
                raise SystemExit(f"{path}:{lineno}: invalid JSON: {exc}") from exc


def main() -> int:
    parser = argparse.ArgumentParser(description="Fit the advisory risk model.")
    parser.add_argument("--input", required=True, type=Path, help="JSONL of traversal contexts")
    parser.add_argument("--out", required=True, type=Path, help="Where to write the joblib artifact")
    parser.add_argument("--contamination", type=float, default=0.05)
    parser.add_argument(
        "--folds",
        type=int,
        default=5,
        help="K for out-of-fold margin estimation; 2+ required for a bias-free reference",
    )
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--version", default=None)
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    rows = list(read_rows(args.input))
    if not rows:
        raise SystemExit(f"No rows read from {args.input}")

    matrix = np.asarray([build_features(row) for row in rows], dtype=float)
    if matrix.shape[0] < MIN_ROWS:
        raise SystemExit(
            f"Only {matrix.shape[0]} rows; need at least {MIN_ROWS} for a usable model. "
            "Collect more routine traversals before training."
        )
    if not np.isfinite(matrix).all():
        bad = np.argwhere(~np.isfinite(matrix))
        names = sorted({FEATURE_NAMES[int(c)] for _r, c in bad})
        raise SystemExit(f"Non-finite feature values in columns: {names}")
    if args.folds < 2 or args.folds > matrix.shape[0]:
        raise SystemExit(f"--folds must be between 2 and {matrix.shape[0]}")

    log.info("Fitting on %s rows x %s features", *matrix.shape)

    pipeline = build_pipeline(args.contamination, args.seed)
    pipeline.fit(matrix)

    # Ship an out-of-fold margin distribution so serving can rank new traffic
    # against rows the model did not train on. Capped to keep the artifact small:
    # a percentile over a sample of this size is already more precise than the
    # model's own reproducibility.
    margins = np.sort(out_of_fold_margins(matrix, args.contamination, args.seed, args.folds))
    if margins.size > MAX_STORED_MARGINS:
        idx = np.linspace(0, margins.size - 1, MAX_STORED_MARGINS).round().astype(int)
        margins = margins[idx]

    # Report what share of the training sample the held-out margins call
    # anomalous. This is the assumed alert rate on routine traffic, and it is the
    # number an analyst must sanity-check before trusting the ordering.
    held_out_flagged = 100.0 * float((margins <= 0.0).mean())

    version = args.version or datetime.now(timezone.utc).strftime("v%Y%m%d-%H%M%S")
    artifact = {
        "pipeline": pipeline,
        "featureNames": list(FEATURE_NAMES),
        "version": version,
        "trainedAt": datetime.now(timezone.utc).isoformat(),
        "trainingRows": int(matrix.shape[0]),
        "margins": [float(m) for m in margins],
        "marginMin": float(margins.min()),
        "marginMax": float(margins.max()),
        "alertRateHint": round(held_out_flagged, 4),
        "note": "Unsupervised anomaly model. Advisory only; not calibrated against outcomes.",
    }

    args.out.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(artifact, args.out)
    log.info("Wrote %s (version=%s rows=%s)", args.out, version, matrix.shape[0])
    log.info(
        "Out-of-fold margins flag %.1f%% of training rows (contamination=%.3f); "
        "that share is the expected alert rate on traffic like the training sample.",
        held_out_flagged,
        args.contamination,
    )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())