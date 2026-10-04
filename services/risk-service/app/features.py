"""
Feature extraction for the advisory risk model.

Mirrors `TraversalContext` in server/src/risk/engine.ts. The feature vector is
the entire contract with the server: if this list changes, the server must be
deployed in step, because a fitted sklearn pipeline validates input width by
position and silently mispredicts on a different order.

Every feature is finite by construction. Graph traversal naturally produces
empty lists and zeros, and a NaN reaching an IsolationForest yields a NaN score
that would surface in the UI as a blank risk number.

Deliberately structural only — no label or analyst-note features
--------------------------------------------------------------------
The rule engine already scores sanctions, mixers, and darknet exposure from the
same label set, and it is the authoritative signal. Feeding labels to the model
as well would count the same evidence twice.

It would also not work. This model is trained on samples of *routine*
traffic, so `label_sanctioned` is constant zero across the whole training set.
An IsolationForest picks split points from observed values, so a constant
column can never be split on and contributes nothing regardless of scaling: in
testing, a case carrying a high-confidence OFAC hit scored 19/100 — below
average risk — because the tree had never seen the signal. Keeping the columns
would advertise a capability the model does not have.

The model therefore scores *structure* the rules do not: timing, fan-out,
consolidation, and value distribution. Known-bad actors stay the rule engine's
job. If analyst-reviewed outcome labels ever accumulate, a supervised model
trained on them would be strictly better than either.
"""

from __future__ import annotations

import math
import statistics
from typing import Any, Mapping, Sequence

# Order is part of the wire contract. Append only; never reorder or remove.
FEATURE_NAMES: tuple[str, ...] = (
    "hop_count",
    "hop_interval_mean",
    "hop_interval_median",
    "hop_interval_min",
    "hop_interval_max",
    "hop_interval_std",
    "interval_burstiness",
    "consolidation_ratio",
    "counterparty_count",
    "log10_total_value_usd",
    "bridge_crossings",
)

# A traversal that moved this much value is already extreme; the log keeps one
# whale from dominating the feature tree. 1e9 USD is far above any real case.
_LOG_FLOOR_USD = 1.0


def _finite(value: float, default: float = 0.0) -> float:
    """Coerce to a finite float; NaN/inf become `default`."""
    if value is None:
        return default
    try:
        out = float(value)
    except (TypeError, ValueError):
        return default
    return out if math.isfinite(out) else default


def _interval_stats(intervals: Sequence[Any]) -> dict[str, float]:
    values = [_finite(i) for i in intervals if i is not None]
    if not values:
        return {
            "hop_interval_mean": 0.0,
            "hop_interval_median": 0.0,
            "hop_interval_min": 0.0,
            "hop_interval_max": 0.0,
            "hop_interval_std": 0.0,
        }
    return {
        "hop_interval_mean": statistics.fmean(values),
        "hop_interval_median": statistics.median(values),
        "hop_interval_min": min(values),
        "hop_interval_max": max(values),
        # pstdev needs >=2 points; a single hop has no spread to measure.
        "hop_interval_std": statistics.pstdev(values) if len(values) > 1 else 0.0,
    }


def _burstiness(mean: float, std: float) -> float:
    """
    Coefficient of variation of the hop intervals.

    Automation produces metronomic hops: a burst of transfers seconds apart.
    Human or business-driven movement is irregular. The mean is floored so an
    empty or single-hop traversal yields 0 rather than a division by zero.
    """
    if mean <= 0.0:
        return 0.0
    return _finite(std / mean)


def build_features(ctx: Mapping[str, Any]) -> list[float]:
    """Build the feature vector for one traversal context."""
    intervals = list(ctx.get("hopIntervals") or [])
    stats = _interval_stats(intervals)

    total_usd = _finite(ctx.get("totalValueUsd"))
    # log10 of a non-positive total is undefined; a traversal worth nothing is
    # encoded as the floor rather than -inf.
    log_value = math.log10(max(total_usd, _LOG_FLOOR_USD))

    vector = {
        "hop_count": float(len(intervals)),
        **stats,
        "interval_burstiness": _burstiness(stats["hop_interval_mean"], stats["hop_interval_std"]),
        "consolidation_ratio": _finite(ctx.get("consolidationRatio")),
        "counterparty_count": _finite(ctx.get("counterpartyCount")),
        "log10_total_value_usd": log_value,
        "bridge_crossings": _finite(ctx.get("bridgeCrossings")),
    }
    return [vector[name] for name in FEATURE_NAMES]


def feature_map(ctx: Mapping[str, Any]) -> dict[str, float]:
    """Named features, for logging and for the training script."""
    return dict(zip(FEATURE_NAMES, build_features(ctx)))