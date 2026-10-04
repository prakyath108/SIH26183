"""HTTP contract tests for the advisory risk service."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import main as main_module  # noqa: E402


@pytest.fixture()
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    """A client whose model holder points at an empty directory: unfitted."""
    holder = main_module.ModelHolder(str(tmp_path / "absent.joblib"))
    holder.load()
    monkeypatch.setattr(main_module, "holder", holder)
    with TestClient(main_module.app) as test_client:
        yield test_client


def test_healthz_is_ok_even_when_unfitted(client: TestClient) -> None:
    """Unfitted is a valid steady state, not an outage to be reported as unhealthy."""
    res = client.get("/healthz")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "ok"
    assert body["ready"] is False


def test_score_returns_null_when_unfitted(client: TestClient) -> None:
    res = client.post("/v1/score", json={"hopIntervals": [1, 2, 3], "totalValueUsd": 1000})
    assert res.status_code == 200
    body = res.json()
    assert body["ready"] is False
    assert body["score"] is None
    assert body["level"] is None
    # The caveat must ride along even when there is no score, so a consumer that
    # caches the payload still carries the framing.
    assert "not a finding of fact" in body["caveat"]


def test_score_accepts_a_full_context(client: TestClient) -> None:
    res = client.post(
        "/v1/score",
        json={
            "hopIntervals": [10, 20],
            "consolidationRatio": 0.5,
            "counterpartyCount": 4,
            "totalValueUsd": 5000,
            "bridgeCrossings": 1,
            "labels": [{"kind": "sanctioned", "name": "X", "source": "ncrp", "confidence": "high"}],
            "analystNotes": [{"note": "reviewed", "author": "a", "at": "2026-01-01T00:00:00Z"}],
            "chain": "ethereum",
            "address": "0xabc",
        },
    )
    assert res.status_code == 200
    assert res.json()["score"] is None


def test_score_tolerates_a_bare_body(client: TestClient) -> None:
    assert client.post("/v1/score", json={}).status_code == 200


def test_model_info_reports_why_it_is_not_ready(client: TestClient) -> None:
    res = client.get("/v1/model")
    assert res.status_code == 200
    body = res.json()
    assert body["ready"] is False
    assert body["message"]
    assert body["featureNames"], "the feature contract must be published even when unfitted"


def test_feature_names_match_the_builder(client: TestClient) -> None:
    from app.features import FEATURE_NAMES

    res = client.get("/v1/model")
    assert tuple(res.json()["featureNames"]) == FEATURE_NAMES