"""
Advisory risk-scoring microservice.

Scope is deliberately narrow: this service returns a second opinion on a
traversal and nothing else. It does not own case state, does not persist scores,
and does not decide a case status. The server's explainable rule engine remains
authoritative, and its cited factors remain what an analyst reads.

It serves no score at all until a model has been fitted with train.py, because
this system has no labelled outcomes to fit one against.
"""

from __future__ import annotations

import logging

from contextlib import asynccontextmanager
from collections.abc import AsyncIterator

from fastapi import FastAPI
from fastapi.responses import JSONResponse

from . import bands
from .features import FEATURE_NAMES
from .model import DEFAULT_MODEL_PATH, ModelHolder
from .schema import HealthResponse, ModelInfo, ScoreRequest, ScoreResponse

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("risk-service")

holder = ModelHolder(DEFAULT_MODEL_PATH)


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    holder.load()
    edges, labels = bands.resolve()
    log.info(
        "Advisory risk service ready=%s bands=%s", holder.ready, list(zip(edges, labels[1:]))
    )
    yield


app = FastAPI(
    title="CryptoTrace advisory risk service",
    version="0.1.0",
    description=(
        "Advisory anomaly score for blockchain traversals. Triage ordering only: "
        "not a finding of fact, and not a substitute for analyst review."
    ),
    lifespan=lifespan,
)


@app.get("/healthz", response_model=HealthResponse)
def healthz() -> HealthResponse:
    """Liveness plus readiness. Never fails when unfitted: that is a valid state."""
    return HealthResponse(status="ok", ready=holder.ready, modelVersion=holder.version)


@app.get("/v1/model", response_model=ModelInfo)
def model_info() -> ModelInfo:
    return ModelInfo(**holder.info())


@app.post("/v1/score", response_model=ScoreResponse)
def score(req: ScoreRequest) -> ScoreResponse:
    """
    Score one traversal.

    Always 200. An unfitted model is `ready:false, score:null` rather than a 503,
    because "no advisory available" is an expected steady state, and the server
    should not have to distinguish it from a genuine outage to decide whether a
    case file is broken.
    """
    value = holder.score(req.as_context())
    edges, labels = bands.resolve()

    return ScoreResponse(
        ready=holder.ready,
        score=value,
        level=bands.band_for(value, edges, labels),
        calibrated=False,
        bandBasis=bands.BAND_BASIS,
        modelVersion=holder.version,
        trainedAt=holder.trained_at,
        featureNames=list(FEATURE_NAMES),
    )


@app.exception_handler(Exception)
async def unhandled(_request: object, exc: Exception) -> JSONResponse:  # pragma: no cover
    log.exception("Unhandled error: %s", exc)
    return JSONResponse(status_code=500, content={"error": "internal_error"})