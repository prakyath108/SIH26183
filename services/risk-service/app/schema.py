"""
Wire contract for the risk service.

The response models the honesty requirement of this system: a score is only ever
returned when a fitted model produced it. `score` is None otherwise. Nothing
fabricates a risk number to fill the field, because in this domain an invented
score is indistinguishable from an assessed one once it reaches a case file.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class Label(BaseModel):
    kind: str
    name: str = ""
    source: str = ""
    confidence: str = "medium"
    observedAt: str | None = None


class AnalystNote(BaseModel):
    note: str
    author: str = ""
    at: str | None = None


class ScoreRequest(BaseModel):
    """Mirrors TraversalContext in server/src/risk/engine.ts."""

    hopIntervals: list[float] = Field(default_factory=list)
    consolidationRatio: float | None = None
    counterpartyCount: int = 0
    totalValueUsd: float = 0.0
    bridgeCrossings: int = 0

    # Accepted and ignored. The model scores structure only; known-bad actors are
    # the rule engine's authoritative job, and a signal absent from a routine
    # training sample is one an IsolationForest cannot learn to weigh. Fields are
    # kept so the server can post an unmodified TraversalContext.
    labels: list[Label] = Field(default_factory=list)
    analystNotes: list[AnalystNote] = Field(default_factory=list)

    # Carried for logging/correlation only; never a scoring input.
    chain: str | None = None
    address: str | None = None
    caseId: str | None = None

    def as_context(self) -> dict[str, Any]:
        """Flatten to the mapping `build_features` consumes."""
        return {
            "hopIntervals": self.hopIntervals,
            "consolidationRatio": self.consolidationRatio,
            "counterpartyCount": self.counterpartyCount,
            "totalValueUsd": self.totalValueUsd,
            "bridgeCrossings": self.bridgeCrossings,
            "labels": [label.model_dump() for label in self.labels],
            "analystNotes": [note.model_dump() for note in self.analystNotes],
        }


class ScoreResponse(BaseModel):
    """
    Advisory only. The server keeps its rule engine authoritative and must treat
    this purely as a second opinion attached to the result.
    """

    ready: bool
    """False when no model is fitted. The server should omit the advisory."""

    score: float | None = None
    """0-100, higher = more anomalous. None unless `ready`."""

    level: str | None = None
    """
    Rarity band, not a severity: "Typical" through "Very rare". See `bandBasis`.
    Deliberately does not reuse the rule engine's Critical/High/Medium/Low
    vocabulary, because nothing here supports a claim about seriousness.
    """

    calibrated: bool = False
    """
    Always False for now, and surfaced so no consumer treats `level` as a
    measured severity.

    The score is a rank against the routine sample the model was trained on,
    which puts the middle of routine traffic at 50 by construction. It is
    meaningful for ordering a queue and meaningless as an absolute risk level:
    there are no outcome labels to calibrate against yet. Flipping this to True
    requires analyst-reviewed outcomes — a supervised model on real labels would
    be strictly better than either this one or the bands.
    """

    bandBasis: str | None = None
    """Plain statement of what the bands mean, so a reader cannot infer a severity."""

    modelVersion: str | None = None
    trainedAt: str | None = None
    featureNames: list[str] = Field(default_factory=list)

    caveat: str = (
        "Advisory model output for triage ordering only. It is a relative rank "
        "within traffic similar to the training sample, not an absolute risk "
        "level or a severity. It is not a finding of fact, does not establish "
        "identity or wrongdoing, and does not replace the analyst-reviewed rule "
        "factors."
    )


class ModelInfo(BaseModel):
    ready: bool
    modelVersion: str | None
    trainedAt: str | None
    featureNames: list[str]
    trainingRows: int | None = None
    modelPath: str | None = None
    message: str | None = None
    calibrated: bool = False
    alertRateHint: float | None = None
    """Share of held-out training rows the model scores at or below its own
    flag threshold. Read as the expected alert rate on traffic resembling the
    training sample, and as a bias check: a value far above `--contamination`
    means the sample is not as routine as it was assumed to be."""


class HealthResponse(BaseModel):
    status: str
    ready: bool
    modelVersion: str | None = None