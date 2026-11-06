"""Tests for the parts of the data pipeline that break silently.

The parsers here are fed real-world shapes (Bovada's handicap strings, the U+2212
minus DraftKings returns, the Odds API's event ids) because a quiet change in any
of them costs a whole refresh, not a single page.

Run: python -m pytest -q tests
"""
import json
import os
import sys
from datetime import datetime, timedelta, timezone

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))

import build_data as B  # noqa: E402
import grading as G     # noqa: E402
import picks as P       # noqa: E402

NOW = datetime(2026, 11, 6, 18, 0, tzinfo=timezone.utc)


def iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------- price parsing
@pytest.mark.parametrize("raw,expected", [
    ("-115", -115), ("+150", 150), ("115", 115),
    ("\u2212110", -110),          # U+2212 MINUS SIGN, what DraftKings returns
    ("\u2013105", -105),          # en dash
    ("EVEN", 100), ("EV", 100),
    ("", None), (None, None), ("-", None), ("abc", None),
])
def test_am_price(raw, expected):
    assert B.am_price(raw) == expected


def test_team_abbr_and_norm():
    assert B.team_abbr("Cincinnati Bengals") == "CIN"
    assert B.team_abbr("not a team") is None
    assert B.norm("A.J. Brown") == "aj brown"
    assert B.norm("Amon-Ra St. Brown") == "amonra st brown"


def test_bovada_main_line_prefers_balanced_then_least_vig():
    # 278.5 is the only line quoted both ways -> it wins even though 280.5 has a dearer over
    sides = {
        "280.5": {"over": -120, "under": None},
        "278.5": {"over": -115, "under": -115},
    }
    h, s = B.bovada_main_line(sides)
    assert float(h) == 278.5 and s == {"over": -115, "under": -115}
    # one-sided alt lines are not a main line: no two-way price, nothing to grade against
    assert B.bovada_main_line({"8.5": {"over": -105, "under": None}}) is None
    assert B.bovada_main_line({}) is None


# ------------------------------------------------------- game id normalisation
def test_nflverse_event_maps_odds_api_game_to_nflverse_id():
    upcoming = [{"id": "2026_09_CIN_ATL", "home": "CIN", "away": "ATL", "ko": iso(datetime(2026, 11, 8, 18, 0, tzinfo=timezone.utc))}]
    assert B.nflverse_event(upcoming, "2026-11-08T18:00:00Z", "CIN", "ATL") == "2026_09_CIN_ATL"
    # a different kickoff window (or an unknown matchup) must not be silently merged
    assert B.nflverse_event(upcoming, "2026-11-15T18:00:00Z", "CIN", "ATL") is None
    assert B.nflverse_event(upcoming, "2026-11-08T18:00:00Z", None, None) is None


# ------------------------------------------------------------- line consensus
def test_consensus_uses_the_line_most_books_post():
    rows = [{"line": 25.5, "over": -110}, {"line": 25.5, "over": -108}, {"line": 26.5, "over": -105}]
    line, at = G.consensus(rows)
    assert line == 25.5 and len(at) == 2
    assert G.consensus([{"line": 1.5}]) is None  # no two-way price, nothing to grade


def test_grade_scores_push_void_and_both_sides(tmp_path):
    arc, res = tmp_path / "arc.json", tmp_path / "res.json"
    entry = {"sport": "nfl", "pid": "p1", "player": "Test", "market": "rush_yds", "line": 50.5,
             "commence": iso(NOW - timedelta(hours=10)), "event": "e", "books": 2}
    # three props, three different outcomes, one of them not yet reported
    arc.write_text(json.dumps({
        "a": dict(entry, line=50.5),
        "b": dict(entry, line=60.0),
        "c": dict(entry, line=70.0),
    }))
    values = {50.5: 51.0, 60.0: 60.0, 70.0: None}   # hit, exact push, not reported yet
    G.grade(str(arc), str(res), lambda e: values[e["line"]], now=NOW, yes_only=("anytime_td",))
    cats = json.loads(res.read_text())["cats"]["rush_yds"]
    assert cats["over"] == [1, 0, 1]     # [hits, misses, pushes]
    assert cats["under"] == [0, 1, 1]    # same numbers from the other side


def test_grade_voids_a_pick_that_never_reports(tmp_path):
    arc, res = tmp_path / "arc.json", tmp_path / "res.json"
    arc.write_text(json.dumps({"k": {"sport": "nfl", "pid": "p", "player": "X", "market": "rush_yds",
                                     "line": 10.5, "commence": iso(NOW - timedelta(hours=100)),
                                     "event": "e", "books": 2}}))
    G.grade(str(arc), str(res), lambda e: None, now=NOW, yes_only=("anytime_td",))
    assert json.loads(arc.read_text())["k"]["graded"] == "void"


# ---------------------------------------------------------------- pick ledger
def test_merge_keeps_the_first_line_per_prop(tmp_path):
    path = tmp_path / "picks.json"
    base = {"pid": "p1", "player": "Test", "market": "rec_yds", "side": 1, "price": -110,
            "book": "Bovada", "score": 61, "event": "e1", "commence": iso(NOW + timedelta(hours=20))}
    assert P.merge(str(path), [dict(base, line=45.5)], NOW) == 1
    # the line moves, the site recommends it again -> we keep the line we first graded
    assert P.merge(str(path), [dict(base, line=47.5)], NOW) == 0
    assert json.loads(path.read_text())["entries"][0]["line"] == 45.5


def test_grade_picks_pays_the_recorded_price_and_reports_clv(tmp_path):
    path = tmp_path / "picks.json"
    commence = NOW - timedelta(hours=8)
    P.merge(str(path), [{"pid": "p1", "player": "Test", "market": "rush_yds", "line": 50.5, "side": 1,
                         "price": -110, "book": "Bovada", "score": 70, "event": "e1", "commence": iso(commence)}],
            NOW - timedelta(hours=30))
    # the closing line was 52.5, i.e. we beat the close by two yards
    hist = {"p1|rush_yds": [(iso(commence - timedelta(hours=5)), "Bovada", 52.5)]}
    done, s = P.grade(str(path), lambda e: 55.0, hist, NOW)
    e = json.loads(path.read_text())["entries"][0]
    assert done == 1 and e["result"] == "hit"
    assert e["pnl"] == pytest.approx(0.909, abs=1e-3)   # +110 = 1.909 decimal -> +0.909 units
    assert e["close"] == 52.5 and e["clv"] == 2.0
    assert s["hits"] == 1 and s["roi"] == pytest.approx(0.909, abs=1e-3)


def test_under_pick_clv_is_signed_towards_our_side():
    hist = {"p1|rec_yds": [("2026-11-01T12:00Z", "Bovada", 40.5)]}
    assert P._closing(hist, "p1", "rec_yds", "2026-11-02T18:00:00Z") == 40.5
    # no history before kickoff -> no closing line, no CLV
    assert P._closing(hist, "p1", "rec_yds", "2026-11-01T00:00:00Z") is None


def test_summarise_reports_roi_and_pending():
    s = P.summarise([
        {"result": "hit", "pnl": 1.0, "clv": 1.0, "market": "rush_yds"},
        {"result": "loss", "pnl": -1.0, "clv": -1.0, "market": "rush_yds"},
        {"market": "rec_yds", "graded": None},
    ])
    assert s["hits"] == 1 and s["losses"] == 1 and s["units"] == 0.0
    assert s["roi"] == 0.0 and s["clv"] == 0.0 and s["pending"] == 1
    assert s["by_market"]["rush_yds"]["n"] == 2
