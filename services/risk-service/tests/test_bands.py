"""
Band labelling.

The bands describe rarity, not severity, so most of what is checked here is that
they cannot drift into claiming more than the model knows.
"""

from __future__ import annotations

import pytest

from app import bands


def test_bands_are_rarity_not_severity() -> None:
    """Regression guard: the bands once reused the rule engine's severity
    thresholds, implying the two scales were calibrated against each other."""
    forbidden = {"critical", "high", "medium", "low", "unrated"}
    for label in bands.DEFAULT_LABELS:
        assert label.lower() not in forbidden, f"{label!r} asserts a severity the model cannot know"


def test_band_edges_are_percentiles_with_the_documented_routine_share() -> None:
    """
    Each edge implies a known share of routine traffic above it, which is what
    makes the vocabulary defensible.

    (An earlier version of this test asserted the edges shared no value with the
    rule engine's 15/35/55/75. That was wrong: 75 is the top quartile, so the
    collision is arithmetic rather than evidence of copying. The label test above
    is the guard that matters.)
    """
    assert bands.DEFAULT_EDGES == (50.0, 75.0, 90.0, 97.0)


def test_top_band_is_a_small_share_of_routine_traffic() -> None:
    """The queue an operator acts on should be a few percent of ordinary traffic."""
    top_edge = bands.DEFAULT_EDGES[-1]
    assert (100.0 - top_edge) <= 5.0, "top band would capture too much routine traffic"


def test_band_boundaries_are_inclusive_at_the_edge() -> None:
    assert bands.band_for(0.0) == "Typical"
    assert bands.band_for(49.99) == "Typical"
    assert bands.band_for(50.0) == "Above typical"
    assert bands.band_for(74.99) == "Above typical"
    assert bands.band_for(75.0) == "Unusual"
    assert bands.band_for(90.0) == "Rare"
    assert bands.band_for(97.0) == "Very rare"
    assert bands.band_for(100.0) == "Very rare"


def test_band_is_monotonic_in_the_score() -> None:
    order = {label: i for i, label in enumerate(bands.DEFAULT_LABELS)}
    seen = [order[bands.band_for(s / 4)] for s in range(0, 401)]
    assert seen == sorted(seen), "band must never go down as the score rises"


def test_no_band_without_a_score() -> None:
    """An unfitted model produced nothing; labelling it would fabricate."""
    assert bands.band_for(None) is None


@pytest.mark.parametrize(
    "raw",
    [
        "",
        "   ",
        "abc",
        "95,80",          # descending
        "95,80,60",       # descending
        "50,50",          # repeated
        "0,50",           # edge at 0
        "50,100",         # edge at 100
        "-10,50",         # negative
        "150",            # above 100
    ],
)
def test_bad_edge_overrides_fall_back_to_defaults(raw: str) -> None:
    """A typo in the environment must not reshape every score's label."""
    assert bands.parse_edges(raw) is None


def test_good_edge_override_is_accepted() -> None:
    assert bands.parse_edges("60, 85, 99") == (60.0, 85.0, 99.0)
    assert bands.parse_edges(" 90 , 99 ") == (90.0, 99.0)


def test_label_override_must_match_edge_count() -> None:
    edges = (50.0, 90.0)
    assert bands.parse_labels("a,b,c", edges) == ("a", "b", "c")
    # Three edges need four labels.
    assert bands.parse_labels("a,b,c", (50.0, 75.0, 90.0)) is None
    assert bands.parse_labels("", edges) is None


def test_resolve_applies_valid_overrides(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("RISK_BAND_EDGES", "70,95")
    monkeypatch.setenv("RISK_BAND_LABELS", "Usual,Uncommon,Singular")
    edges, labels = bands.resolve()
    assert edges == (70.0, 95.0)
    assert labels == ("Usual", "Uncommon", "Singular")
    assert bands.band_for(96.0, edges, labels) == "Singular"


def test_resolve_ignores_invalid_overrides(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("RISK_BAND_EDGES", "nonsense")
    monkeypatch.delenv("RISK_BAND_LABELS", raising=False)
    edges, labels = bands.resolve()
    assert edges == bands.DEFAULT_EDGES
    assert labels == bands.DEFAULT_LABELS


def test_mismatched_override_cannot_raise_on_the_request_path() -> None:
    """Defensive: an inconsistent pair must return None, not throw."""
    assert bands.band_for(80.0, edges=(50.0, 75.0), labels=("only", "two")) is None