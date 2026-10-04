"""Tests for the advisory risk service.

The load-bearing assertion is that an unfitted model yields `score is None`. If
that ever regresses to a number, the system starts showing invented risk
verdicts in case files, which is the one failure mode this service must not have.
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.features import FEATURE_NAMES, build_features, feature_map  # noqa: E402
from app.model import ModelHolder  # noqa: E402
from app.schema import ScoreRequest  # noqa: E402


def test_feature_vector_is_finite_for_empty_context() -> None:
    vector = build_features({})
    assert len(vector) == len(FEATURE_NAMES)
    assert all(math.isfinite(v) for v in vector), "empty context must not yield NaN/inf"


def test_feature_vector_is_finite_for_full_context() -> None:
    vector = build_features(
        {
            "hopIntervals": [1.5, 20, 3600],
            "consolidationRatio": 0.85,
            "counterpartyCount": 12,
            "totalValueUsd": 1_250_000,
            "bridgeCrossings": 2,
            "labels": [
                {"kind": "mixer", "confidence": "high"},
                {"kind": "exchange", "confidence": "low"},
                {"kind": "not_a_kind", "confidence": "medium"},
            ],
            "analystNotes": [{"note": "x"}],
        }
    )
    assert all(math.isfinite(v) for v in vector)


def test_zero_total_value_does_not_produce_neg_inf() -> None:
    vector = build_features({"totalValueUsd": 0})
    assert all(math.isfinite(v) for v in vector), "log10(0) must be floored, not -inf"


def test_negative_total_value_does_not_produce_nan() -> None:
    vector = build_features({"totalValueUsd": -500})
    assert all(math.isfinite(v) for v in vector)


def test_single_hop_interval_has_zero_spread() -> None:
    """pstdev of one sample is a ZeroDivisionError, not 0."""
    features = feature_map({"hopIntervals": [42]})
    assert features["hop_interval_std"] == 0.0
    assert features["hop_interval_mean"] == 42.0


def test_labels_are_ignored_by_the_model() -> None:
    """The model scores structure only; known-bad actors stay the rule engine's job.

    Regression guard for a real miss: with labels as features, `label_sanctioned`
    was constant zero across routine training data, so an IsolationForest could
    never split on it and a case carrying a high-confidence OFAC hit scored
    19/100 — below average risk.
    """
    structural = {"hopIntervals": [60, 90], "counterpartyCount": 4, "totalValueUsd": 8000}
    labelled = {**structural, "labels": [{"kind": "sanctioned", "confidence": "high"}]}
    noted = {**structural, "analystNotes": [{"note": "suspicious"}]}

    assert build_features(labelled) == build_features(structural)
    assert build_features(noted) == build_features(structural)
    assert not any(name.startswith("label_") for name in FEATURE_NAMES)
    assert "analyst_note_count" not in FEATURE_NAMES


def test_burstiness_separates_metronomic_from_irregular_hops() -> None:
    """Automation moves value in evenly spaced hops; humans do not."""
    metronomic = feature_map({"hopIntervals": [10, 10, 10, 10]})["interval_burstiness"]
    irregular = feature_map({"hopIntervals": [1, 500, 2, 900]})["interval_burstiness"]

    assert metronomic == 0.0
    assert irregular > metronomic
    # A single hop has no spread to measure; must not divide by zero.
    assert feature_map({"hopIntervals": []})["interval_burstiness"] == 0.0
    assert feature_map({"hopIntervals": [42]})["interval_burstiness"] == 0.0


def test_request_flattens_to_context() -> None:
    req = ScoreRequest(
        hopIntervals=[3.0],
        labels=[{"kind": "bridge", "name": "Across", "source": "ncrp", "confidence": "high"}],
        chain="bitcoin",
        address="bc1q",
    )
    ctx = req.as_context()
    assert ctx["hopIntervals"] == [3.0]
    assert ctx["labels"][0]["kind"] == "bridge"
    # chain/address are correlation only and must not leak into features.
    assert "chain" not in ctx and "address" not in ctx
    assert len(build_features(ctx)) == len(FEATURE_NAMES)


def test_unfitted_model_scores_none(tmp_path: Path) -> None:
    holder = ModelHolder(str(tmp_path / "missing.joblib"))
    holder.load()
    assert holder.ready is False
    assert holder.score({}) is None, "no model must mean no score, never a default number"
    assert holder.message


def test_corrupt_model_file_is_reported_not_raised(tmp_path: Path) -> None:
    bad = tmp_path / "risk.joblib"
    bad.write_text("not a joblib artifact", encoding="utf-8")
    holder = ModelHolder(str(bad))
    holder.load()
    assert holder.ready is False
    assert holder.score({}) is None


def test_feature_order_mismatch_refuses_to_load(tmp_path: Path) -> None:
    """A model fitted on a different feature order must not silently mispredict."""
    import joblib
    from sklearn.ensemble import IsolationForest

    pipeline = IsolationForest(n_estimators=10, random_state=0).fit(np.zeros((60, len(FEATURE_NAMES))))
    artifact = {
        "pipeline": pipeline,
        "featureNames": ["wrong_feature"] * len(FEATURE_NAMES),
        "version": "v-bad",
    }
    path = tmp_path / "risk.joblib"
    joblib.dump(artifact, path)

    holder = ModelHolder(str(path))
    holder.load()
    assert holder.ready is False
    assert "does not match" in (holder.message or "")
    assert holder.score({}) is None


def _fit(training: np.ndarray, tmp_path: Path, **extra: object) -> ModelHolder:
    """Fit and persist an artifact the way train.py does."""
    import joblib
    from sklearn.ensemble import IsolationForest
    from sklearn.pipeline import Pipeline
    from sklearn.preprocessing import RobustScaler

    pipeline = Pipeline(
        [("scaler", RobustScaler()), ("model", IsolationForest(n_estimators=100, contamination=0.05, random_state=0))]
    )
    pipeline.fit(training)
    margins = np.sort(pipeline.decision_function(training))
    artifact = {
        "pipeline": pipeline,
        "featureNames": list(FEATURE_NAMES),
        "version": "v-test",
        "trainedAt": "2026-01-01T00:00:00+00:00",
        "trainingRows": int(training.shape[0]),
        "margins": [float(m) for m in margins],
        "marginMin": float(margins.min()),
        "marginMax": float(margins.max()),
        **extra,
    }
    path = tmp_path / "risk.joblib"
    joblib.dump(artifact, path)
    holder = ModelHolder(str(path))
    holder.load()
    return holder


def test_fitted_model_scores_and_ranks_anomalies(tmp_path: Path) -> None:
    rng = np.random.default_rng(7)
    training = np.column_stack([rng.normal(0, 1, 200) for _ in FEATURE_NAMES])
    holder = _fit(training, tmp_path)

    assert holder.ready is True
    assert holder.version == "v-test"

    quiet = holder.score({"hopIntervals": [], "counterpartyCount": 1, "totalValueUsd": 10})
    wild = holder.score(
        {
            "hopIntervals": [0.1] * 12,
            "counterpartyCount": 400,
            "totalValueUsd": 90_000_000,
            "bridgeCrossings": 5,
            "labels": [{"kind": "mixer", "confidence": "high"}] * 8,
        }
    )
    assert quiet is not None and wild is not None
    assert 0 <= quiet <= 100 and 0 <= wild <= 100
    # Distance-from-normal must rank the extreme case above the quiet one.
    assert wild > quiet, f"expected anomaly ({wild}) > quiet ({quiet})"


def test_rank_map_spreads_across_the_range(tmp_path: Path) -> None:
    """Regression: a fixed sigmoid pinned routine and anomalous cases both near
    50, which leaves the score unable to order a triage queue."""
    rng = np.random.default_rng(3)
    training = np.column_stack([rng.normal(0, 1, 300) for _ in FEATURE_NAMES])
    holder = _fit(training, tmp_path)

    inlier = holder.score({"counterpartyCount": 0, "totalValueUsd": 0})
    far_out = holder.score(
        {"counterpartyCount": 900, "totalValueUsd": 99_000_000, "hopIntervals": [0.01] * 20}
    )
    assert inlier is not None and far_out is not None
    assert inlier <= 25.0, f"a quiet case scored {inlier}; the map is not rank-based"
    assert far_out >= 75.0, f"an extreme case scored {far_out}; the map is not rank-based"


def test_scores_outside_training_range_clamp_to_the_ends(tmp_path: Path) -> None:
    rng = np.random.default_rng(5)
    training = np.column_stack([rng.normal(0, 1, 200) for _ in FEATURE_NAMES])
    holder = _fit(training, tmp_path)

    # Every feature pushed hard in the anomalous direction.
    extreme = holder.score(
        {
            "hopIntervals": [0.001] * 30,
            "consolidationRatio": 500,
            "counterpartyCount": 5000,
            "totalValueUsd": 10_000_000_000,
            "bridgeCrossings": 50,
            "labels": [{"kind": k, "confidence": "high"} for k in ("mixer", "sanctioned", "darknet")] * 20,
            "analystNotes": [{"note": "n"}] * 50,
        }
    )
    assert extreme == 100.0


@pytest.mark.parametrize("bad", [{"totalValueUsd": float("nan")}, {"consolidationRatio": float("inf")}])
def test_non_finite_inputs_are_coerced(bad: dict) -> None:
    vector = build_features(bad)
    assert all(math.isfinite(v) for v in vector)