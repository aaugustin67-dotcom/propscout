"""Dabble's frontend payload -> our prop records.

Its selections carry no marketId (the market name prefixes the selection name) and
odds are decimal, so both joins are worth pinning down with a fixture.
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))

import build_data as B  # noqa: E402

UPCOMING = [{"id": "2026_09_CIN_ATL", "home": "ATL", "away": "CIN", "ko": "2026-11-08T18:00:00+00:00"}]
PAYLOAD = [{
    "id": "fx1", "name": "Cincinnati Bengals @ Atlanta Falcons", "status": "Open",
    "advertisedStart": "2026-11-08T14:30:00.000Z",
    "markets": [
        {"id": "m1", "name": "Joe Burrow passing-yards", "resultingType": "passing-yards", "isDisplayed": True},
        {"id": "m2", "name": "Joe Burrow anytime-touchdown", "resultingType": "anytime-touchdown", "isDisplayed": True},
        {"id": "m3", "name": "Joe Burrow second-half-passing-yards", "resultingType": "second-half-passing-yards"},
        {"id": "m4", "name": "Ja'Marr Chase receptions", "resultingType": "receptions", "isDisplayed": True},
    ],
    "selections": [
        {"id": "s1", "name": "Joe Burrow passing-yards 250.5 over"},
        {"id": "s2", "name": "Joe Burrow passing-yards 250.5 under"},
        {"id": "s3", "name": "Joe Burrow passing-yards 240.5 over"},
        {"id": "s4", "name": "Joe Burrow anytime-touchdown"},
        {"id": "s5", "name": "Joe Burrow second-half-passing-yards 125.5 over"},
        {"id": "s6", "name": "Ja'Marr Chase receptions 6.5 over"},
        {"id": "s7", "name": "Ja'Marr Chase receptions 6.5 under"},
    ],
    "prices": [
        {"selectionId": "s1", "price": 1.91}, {"selectionId": "s2", "price": 1.91},
        {"selectionId": "s3", "price": 1.80}, {"selectionId": "s4", "price": 2.50},
        {"selectionId": "s5", "price": 1.95},
        {"selectionId": "s6", "price": 2.05}, {"selectionId": "s7", "price": 1.78},
    ],
}]


def test_decimal_to_american():
    assert B.dec_to_am(1.91) == -110
    assert B.dec_to_am(2.5) == 150
    assert B.dec_to_am(1.0) is None and B.dec_to_am("x") is None


def test_parses_full_game_markets_only_and_maps_the_game():
    rows = B.dabble_lines(PAYLOAD, UPCOMING, {"joe burrow": "p1", "jamarr chase": "p2"})
    by = {(r["market"], r["line"]): r for r in rows}
    assert ("pass_yds", 250.5) in by, by.keys()          # half-time market ignored
    r = by[("pass_yds", 250.5)]
    assert r["book"] == "Dabble" and r["event"] == "2026_09_CIN_ATL"
    assert r["over"] == -110 and r["under"] == -110       # decimal converted to American
    assert r["pid"] == "p1"
    atd = by[("anytime_td", 0.5)]
    assert atd["over"] == 150 and atd["under"] is None    # yes-only market
    assert ("receptions", 6.5) in by
    assert all("second-half" not in r["market"] for r in rows)


def test_fixture_outside_the_slate_is_ignored():
    rows = B.dabble_lines(PAYLOAD, [], {})
    assert rows == []
