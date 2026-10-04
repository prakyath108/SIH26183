"""
Model loading and scoring.

The service ships **no** pretrained model. There is no labelled outcome data in
this system — a case's status is a workflow state (who is reviewing it), not a
ground-truth judgement — so any model fitted at build time would be fitted on
invented labels and would look authoritative while being meaningless.

Therefore the default state is `ready=False`, and `score()` returns None. The
caller omits the advisory. `train.py` fits a model from analyst-reviewed rows
once such data exists, and the service then serves it.

The model is an IsolationForest: unsupervised, so it needs no outcome labels,
only a representative sample of normal traversals to learn the shape of routine
activity. It scores distance-from-normal, not "is this a crime".
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import joblib
import numpy as np

from .features import FEATURE_NAMES, build_features

log = logging.getLogger("risk-service")

DEFAULT_MODEL_PATH = os.getenv("MODEL_PATH", "/app/models/risk.joblib")

# A fitted IsolationForest stores training feature width. If FEATURE_NAMES has
# since changed, the pipeline would still accept the new width and mispredict
# silently, so the width is checked explicitly.
EXPECTED_FEATURE_COUNT = len(FEATURE_NAMES)


@dataclass(frozen=True)
class FittedModel:
    pipeline: Any
    version: str
    trained_at: str | None
    training_rows: int | None
    # Histogram of training decision_function margins, plus the range they span.
    #
    # The 0-100 map is a rank transform against this training distribution rather
    # than a fixed curve. IsolationForest margins are small, tightly clustered
    # numbers whose scale shifts with contamination and sample shape, so a fixed
    # sigmoid (or a two-quantile linear map) either pins everything near 50 or
    # saturates at 100 and destroys the ordering the score exists to provide. A
    # percentile is scale-free and always spreads across the full range.
    margins: tuple[float, ...] = ()
    margin_min: float | None = None
    margin_max: float | None = None
    alert_rate_hint: float | None = None
    """Share of out-of-fold training rows scoring at or below the flag threshold.
    Expected alert rate on traffic resembling the training sample."""


def _optional_float(value: Any) -> float | None:
    """Read a number from an artifact, tolerating absence or corruption."""
    if value is None:
        return None
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if np.isfinite(out) else None


def _as_floats(value: Any) -> list[float]:
    """Coerce a stored margin list, dropping anything unusable."""
    if not isinstance(value, (list, tuple)):
        return []
    out: list[float] = []
    for item in value:
        parsed = _optional_float(item)
        if parsed is not None:
            out.append(parsed)
    return sorted(out)


def _percentile_of(sorted_values: tuple[float, ...], value: float) -> float:
    """Fraction of `sorted_values` at or below `value`, in [0, 1]."""
    if not sorted_values:
        return 0.5
    low, high = 0, len(sorted_values)
    while low < high:
        mid = (low + high) // 2
        if sorted_values[mid] <= value:
            low = mid + 1
        else:
            high = mid
    return low / len(sorted_values)


def _map_to_score(raw: float, model: FittedModel) -> float:
    """
    Map a raw decision_function margin onto 0-100, higher = more anomalous.

    Rank-based against the training margins: a routine case scores near 0 and an
    outlier near 100, with the scale derived from the data rather than assumed.
    Values outside the training range clamp to the ends, which is the honest
    reading — the model has no evidence about how unusual they really are.
    """
    if not model.margins:
        # Legacy artifact trained before margins were persisted. A sigmoid still
        # preserves ordering, whereas an empty percentile would return 50 for
        # every input and read as a real mid-risk verdict.
        return round(float(100.0 / (1.0 + np.exp(raw))), 2)

    if model.margin_min is not None and model.margin_max is not None:
        if raw >= model.margin_max:
            return 0.0
        if raw <= model.margin_min:
            return 100.0
    percentile = _percentile_of(model.margins, raw)
    return round(float(min(100.0, max(0.0, 100.0 * (1.0 - percentile)))), 2)


class ModelHolder:
    """Holds the fitted model, or explains why there isn't one."""

    def __init__(self, model_path: str = DEFAULT_MODEL_PATH) -> None:
        self.model_path = model_path
        self._fitted: FittedModel | None = None
        self._load_error: str | None = None

    @property
    def ready(self) -> bool:
        return self._fitted is not None

    def load(self) -> None:
        """Load the model if present. Absence is normal, not an error."""
        path = Path(self.model_path)
        if not path.exists():
            self._load_error = f"No model at {self.model_path}; serving advisory disabled."
            log.info(self._load_error)
            return

        try:
            artifact = joblib.load(path)
        except Exception as exc:  # noqa: BLE001 - surface any load failure
            self._load_error = f"Model at {self.model_path} failed to load: {exc}"
            log.exception(self._load_error)
            return

        pipeline = artifact.get("pipeline") if isinstance(artifact, dict) else artifact
        meta = artifact if isinstance(artifact, dict) else {}
        feature_names = meta.get("featureNames")

        if feature_names is not None and tuple(feature_names) != FEATURE_NAMES:
            self._load_error = (
                f"Model feature order does not match this build: "
                f"{len(feature_names)} vs {EXPECTED_FEATURE_COUNT}. Retrain."
            )
            log.error(self._load_error)
            return

        width = getattr(pipeline, "n_features_in_", None)
        if width is not None and int(width) != EXPECTED_FEATURE_COUNT:
            self._load_error = f"Model expects {width} features, this build emits {EXPECTED_FEATURE_COUNT}."
            log.error(self._load_error)
            return

        self._fitted = FittedModel(
            pipeline=pipeline,
            version=str(meta.get("version") or "unknown"),
            trained_at=meta.get("trainedAt"),
            training_rows=meta.get("trainingRows"),
            margins=tuple(_as_floats(meta.get("margins"))),
            margin_min=_optional_float(meta.get("marginMin")),
            margin_max=_optional_float(meta.get("marginMax")),
            alert_rate_hint=_optional_float(meta.get("alertRateHint")),
        )
        self._load_error = None
        log.info("Loaded model %s trained at %s", self._fitted.version, self._fitted.trained_at)

    @property
    def message(self) -> str | None:
        return self._load_error

    @property
    def version(self) -> str | None:
        return self._fitted.version if self._fitted else None

    @property
    def trained_at(self) -> str | None:
        return self._fitted.trained_at if self._fitted else None

    @property
    def training_rows(self) -> int | None:
        return self._fitted.training_rows if self._fitted else None

    def score(self, context: dict[str, Any]) -> float | None:
        """
        Advisory 0-100, or None when no model is fitted.

        None is the honest answer here. Returning a default such as 0 or 50 would
        be indistinguishable from a real low-risk verdict to the UI and to the
        case file, and a reader would reasonably act on it.
        """
        if not self._fitted:
            return None

        vector = np.asarray([build_features(context)], dtype=float)
        if vector.shape[1] != EXPECTED_FEATURE_COUNT:
            log.error("Feature width mismatch at score time: %s", vector.shape)
            return None

        try:
            # decision_function: higher = more normal. The map below flips it so
            # that higher = more anomalous, matching the rule engine's direction.
            raw = float(self._fitted.pipeline.decision_function(vector)[0])
        except Exception as exc:  # noqa: BLE001 - a scoring failure must not 500
            log.exception("Scoring failed: %s", exc)
            return None

        if not np.isfinite(raw):
            return None

        # Scaled to the rule engine's 0-100 so the two are visually comparable.
        # They are NOT calibrated against each other and must not be averaged.
        return _map_to_score(raw, self._fitted)

    def info(self) -> dict[str, Any]:
        return {
            "ready": self.ready,
            "modelVersion": self.version,
            "trainedAt": self.trained_at,
            "featureNames": list(FEATURE_NAMES),
            "trainingRows": self.training_rows,
            "modelPath": self.model_path,
            "message": self.message,
            "calibrated": False,
            "alertRateHint": self._fitted.alert_rate_hint if self._fitted else None,
        }


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()