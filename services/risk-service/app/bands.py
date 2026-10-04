"""
Result bands for the advisory score.

Why these are rarity bands and not severity bands
-------------------------------------------------
The score is a percentile of a decision-function margin against the margin
distribution of the training sample (see `app.model._map_to_score`). Two
consequences follow, and together they determine what a band may honestly say:

1. **The map is scale-free.** Because the score is a rank, band edges expressed
   as percentiles mean the same thing for every model, regardless of how wide
   or narrow its raw margins happen to be. That is why these edges are constants
   rather than something fitted per artifact.

2. **Routine traffic is centred.** Roughly half of all traffic resembling the
   training sample scores above 50. A severity vocabulary applied to that
   distribution asserts things the model cannot know: nothing in this service
   has any evidence about whether a case is criminal, and the rule engine is the
   authoritative assessment.

So the bands describe how unusual a case is *relative to similar traffic*, and
each edge implies a known share of routine traffic above it:

    score >= 50   "Above typical"   ~50% of routine traffic
    score >= 75   "Unusual"         ~25%
    score >= 90   "Rare"            ~10%
    score >= 97   "Very rare"        ~3%

That last line is the actionable one: it is the share of ordinary traffic that
would reach the top of a triage queue. An operator who wants a queue of ~1% can
raise the final edge to 99 without touching code.

The previous implementation reused the rule engine's 15/35/55/75 severity
thresholds. That was the worst of both options: it implied the two scales were
calibrated against each other, which they demonstrably are not, and it called a
case "Critical" on no evidence at all.
"""

from __future__ import annotations

import os
from typing import Sequence

# Ascending score edges. A score below the first edge is the lowest band.
DEFAULT_EDGES: tuple[float, ...] = (50.0, 75.0, 90.0, 97.0)

# One label per band, lowest first. Length must equal len(edges) + 1.
DEFAULT_LABELS: tuple[str, ...] = (
    "Typical",
    "Above typical",
    "Unusual",
    "Rare",
    "Very rare",
)

BAND_BASIS = (
    "Percentile of the model's training-sample margin distribution. Describes "
    "how unusual a case is relative to similar traffic, not how serious it is."
)

_EDGES_ENV = "RISK_BAND_EDGES"
_LABELS_ENV = "RISK_BAND_LABELS"


def parse_edges(raw: str | None) -> tuple[float, ...] | None:
    """
    Parse an operator override of the band edges.

    Returns None when unset or unparseable, so a typo in the environment
    degrades to the defaults instead of silently reshaping every score's label.
    """
    if raw is None or not raw.strip():
        return None
    try:
        edges = tuple(float(part) for part in raw.split(",") if part.strip())
    except ValueError:
        return None
    return edges if _valid_edges(edges) else None


def parse_labels(raw: str | None, edges: Sequence[float]) -> tuple[str, ...] | None:
    """Parse an operator override of the band labels, if the count matches."""
    if raw is None or not raw.strip():
        return None
    labels = tuple(part.strip() for part in raw.split(",") if part.strip())
    return labels if len(labels) == len(edges) + 1 else None


def _valid_edges(edges: Sequence[float]) -> bool:
    if not edges:
        return False
    if any(e <= 0.0 or e >= 100.0 for e in edges):
        return False
    return all(a < b for a, b in zip(edges, edges[1:]))


def resolve() -> tuple[tuple[float, ...], tuple[str, ...]]:
    """Band edges and labels, honouring environment overrides."""
    edges = parse_edges(os.environ.get(_EDGES_ENV)) or DEFAULT_EDGES
    labels = parse_labels(os.environ.get(_LABELS_ENV), edges) or DEFAULT_LABELS
    return edges, labels


def band_for(score: float | None, edges: Sequence[float] | None = None,
             labels: Sequence[str] | None = None) -> str | None:
    """
    Label a score, highest band first.

    None for a None score: an unfitted model has produced nothing, and inventing
    a band for it would be the same fabrication as inventing the score.
    """
    if score is None:
        return None
    edges = tuple(edges) if edges else DEFAULT_EDGES
    labels = tuple(labels) if labels else DEFAULT_LABELS
    if len(labels) != len(edges) + 1:
        # Defensive: a mismatched override must not raise on the request path.
        return None

    band = labels[0]
    for edge, label in zip(edges, labels[1:]):
        if score >= edge:
            band = label
        else:
            break
    return band