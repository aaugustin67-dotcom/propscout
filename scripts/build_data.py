#!/usr/bin/env python3
"""PropScout data builder.

Pulls free NFL data and writes compact JSON for the static site in docs/data/.
Sources (no key needed): nflverse weekly player stats, nflverse schedule, ESPN injuries.
Optional: The Odds API player props (env ODDS_API_KEY), with a strict budget guard
so the free tier (500 credits/month) is never exceeded.
"""
import csv, io, json, os, re, sys, time, urllib.request, urllib.error
from datetime import datetime, timezone, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "docs", "data")
os.makedirs(OUT, exist_ok=True)
NOW = datetime.now(timezone.utc)

SEASONS = [int(s) for s in os.environ.get("SEASONS", "").split(",") if s] or None
POS = {"QB", "RB", "WR", "TE", "FB"}
STAT_COLS = ["completions", "attempts", "passing_yards", "passing_tds", "passing_interceptions",
             "carries", "rushing_yards", "rushing_tds", "receptions", "targets",
             "receiving_yards", "receiving_tds"]

TEAM_NAMES = {
 "Arizona Cardinals":"ARI","Atlanta Falcons":"ATL","Baltimore Ravens":"BAL","Buffalo Bills":"BUF",
 "Carolina Panthers":"CAR","Chicago Bears":"CHI","Cincinnati Bengals":"CIN","Cleveland Browns":"CLE",
 "Dallas Cowboys":"DAL","Denver Broncos":"DEN","Detroit Lions":"DET","Green Bay Packers":"GB",
 "Houston Texans":"HOU","Indianapolis Colts":"IND","Jacksonville Jaguars":"JAX","Kansas City Chiefs":"KC",
 "Los Angeles Rams":"LA","Los Angeles Chargers":"LAC","Las Vegas Raiders":"LV","Miami Dolphins":"MIA",
 "Minnesota Vikings":"MIN","New England Patriots":"NE","New Orleans Saints":"NO","New York Giants":"NYG",
 "New York Jets":"NYJ","Philadelphia Eagles":"PHI","Pittsburgh Steelers":"PIT","Seattle Seahawks":"SEA",
 "San Francisco 49ers":"SF","Tampa Bay Buccaneers":"TB","Tennessee Titans":"TEN","Washington Commanders":"WAS",
}

MARKETS = {  # Odds API market key -> our key
 "player_pass_yds":"pass_yds","player_pass_tds":"pass_tds","player_pass_completions":"completions",
 "player_rush_yds":"rush_yds","player_reception_yds":"rec_yds","player_receptions":"receptions",
 "player_anytime_td":"anytime_td",
}

log = []
def note(src, status, msg=""):
    log.append({"source": src, "status": status, "message": msg, "at": NOW.isoformat()})
    print(f"[{src}] {status} {msg}", file=sys.stderr)

def fetch(url, timeout=60, tries=3):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "PropScout/1.0 (personal research)"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read(), dict(r.headers)
        except Exception as e:  # noqa
            last = e
            time.sleep(2 * (i + 1))
    raise last

def norm(name):
    n = (name or "").lower()
    n = re.sub(r"[.'`’\-]", "", n)
    n = re.sub(r"\b(jr|sr|ii|iii|iv|v)\b", "", n)
    return re.sub(r"\s+", " ", n).strip()

def num(v):
    try:
        f = float(v)
        return int(f) if f.is_integer() else round(f, 1)
    except (TypeError, ValueError):
        return 0

def load_json(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return default

def save(name, obj):
    with open(os.path.join(OUT, name), "w") as f:
        json.dump(obj, f, separators=(",", ":"))

# ---------------- schedule ----------------
def load_schedule():
    raw, _ = fetch("https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv")
    rows = list(csv.DictReader(io.StringIO(raw.decode("utf-8"))))
    note("schedule", "ok", f"{len(rows)} games")
    return rows

def current_season(sched):
    played = [int(g["season"]) for g in sched if g["home_score"] not in ("", "NA")]
    return max(played) if played else NOW.year

def kickoff_utc(g):
    # gameday YYYY-MM-DD, gametime HH:MM in US/Eastern. EST/EDT approximated by DST rule.
    try:
        d = datetime.strptime(f"{g['gameday']} {g['gametime'] or '13:00'}", "%Y-%m-%d %H:%M")
    except ValueError:
        return None
    y = d.year
    # DST: 2nd Sunday March .. 1st Sunday Nov
    mar = datetime(y, 3, 8); mar += timedelta(days=(6 - mar.weekday()) % 7)
    nov = datetime(y, 11, 1); nov += timedelta(days=(6 - nov.weekday()) % 7)
    off = 4 if mar <= d < nov else 5
    return (d + timedelta(hours=off)).replace(tzinfo=timezone.utc)

# ---------------- player stats ----------------
def load_stats(seasons):
    rows = []
    for s in seasons:
        url = f"https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_{s}.csv"
        try:
            raw, _ = fetch(url, timeout=120)
            part = list(csv.DictReader(io.StringIO(raw.decode("utf-8"))))
            rows += part
            note(f"stats_{s}", "ok", f"{len(part)} rows")
        except Exception as e:
            note(f"stats_{s}", "error", str(e))
    return rows

# ---------------- injuries ----------------
def load_injuries():
    try:
        raw, _ = fetch("https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries")
        data = json.loads(raw)
    except Exception as e:
        note("injuries", "error", str(e)); return None
    out = []
    for t in data.get("injuries", []):
        team = TEAM_NAMES.get(t.get("displayName"), t.get("displayName"))
        for i in t.get("injuries", []):
            a = i.get("athlete", {}) or {}
            out.append({"team": team, "name": a.get("displayName"),
                        "pos": ((a.get("position") or {}).get("abbreviation")),
                        "status": i.get("status"),
                        "detail": (i.get("shortComment") or "")[:220],
                        "date": i.get("date")})
    note("injuries", "ok", f"{len(out)} entries")
    return out

# ---------------- odds ----------------
def load_odds(upcoming, players_by_norm):
    key = os.environ.get("ODDS_API_KEY", "").strip()
    state_path = os.path.join(OUT, "odds_state.json")
    state = load_json(state_path, {"events": {}, "remaining": None, "used": None, "updated": None})
    props_path = os.path.join(OUT, "props.json")
    props = load_json(props_path, {"updated": None, "lines": []})
    hist_path = os.path.join(OUT, "line_history.json")
    hist = load_json(hist_path, {})
    if not key:
        note("odds", "skipped", "ODDS_API_KEY not set - using model lines")
        state["has_key"] = False
        save("odds_state.json", state)
        return props, state
    state["has_key"] = True
    window_h = float(os.environ.get("ODDS_WINDOW_HOURS", "30"))
    per_event = int(os.environ.get("ODDS_FETCHES_PER_EVENT", "1"))
    min_left = int(os.environ.get("ODDS_MIN_REMAINING", "30"))
    base = "https://api.the-odds-api.com/v4/sports/americanfootball_nfl"
    try:
        raw, ehdr = fetch(f"{base}/events?apiKey={key}")  # free call
        events = json.loads(raw)
        eh = {k.lower(): v for k, v in ehdr.items()}
        state["remaining"] = eh.get("x-requests-remaining", state.get("remaining"))
        state["used"] = eh.get("x-requests-used", state.get("used"))
    except Exception as e:
        note("odds", "error", f"events: {str(e).replace(key, '***')}")
        return props, state
    # drop stale lines (games already started)
    lines = [l for l in props.get("lines", []) if l.get("commence") and datetime.fromisoformat(l["commence"].replace("Z", "+00:00")) > NOW - timedelta(hours=4)]
    fetched = 0
    for ev in sorted(events, key=lambda e: e["commence_time"]):
        ct = datetime.fromisoformat(ev["commence_time"].replace("Z", "+00:00"))
        if ct < NOW or ct > NOW + timedelta(hours=window_h):
            continue
        es = state["events"].setdefault(ev["id"], {"fetches": 0})
        if es["fetches"] >= per_event or es.get("empty", 0) >= 6:
            continue
        if state.get("remaining") is not None and int(state["remaining"]) < min_left:
            note("odds", "budget", f"only {state['remaining']} credits left - skipping")
            break
        url = (f"{base}/events/{ev['id']}/odds?apiKey={key}&regions=us&oddsFormat=american"
               f"&markets={','.join(MARKETS)}")
        try:
            raw, hdr = fetch(url)
        except urllib.error.HTTPError as e:
            note("odds", "error", f"{ev['id']}: HTTP {e.code}"); continue
        except Exception as e:
            note("odds", "error", f"{ev['id']}: {str(e).replace(key, '***')}"); continue
        h = {k.lower(): v for k, v in hdr.items()}
        state["remaining"] = h.get("x-requests-remaining", state.get("remaining"))
        state["used"] = h.get("x-requests-used", state.get("used"))
        es["last"] = NOW.isoformat()
        data = json.loads(raw)
        if not any(bk.get("markets") for bk in data.get("bookmakers", [])):
            # books haven't posted props yet (costs 0 credits) - retry on a later run
            es["empty"] = es.get("empty", 0) + 1
            continue
        es["fetches"] += 1; fetched += 1
        home = TEAM_NAMES.get(data.get("home_team")); away = TEAM_NAMES.get(data.get("away_team"))
        lines = [l for l in lines if l["event"] != ev["id"]]
        agg = {}
        for bk in data.get("bookmakers", []):
            for m in bk.get("markets", []):
                mk = MARKETS.get(m["key"])
                if not mk: continue
                for o in m.get("outcomes", []):
                    pn = o.get("description") or ""
                    k2 = (norm(pn), mk, bk["key"], o.get("point"))
                    rec = agg.setdefault(k2, {"player": pn, "pid": players_by_norm.get(norm(pn)), "market": mk,
                                              "book": bk["title"], "line": o.get("point", 0.5) if o.get("point") is not None else 0.5,
                                              "over": None, "under": None, "event": ev["id"],
                                              "commence": ev["commence_time"], "home": home, "away": away})
                    side = o.get("name", "").lower()
                    if side in ("over", "yes"): rec["over"] = o.get("price")
                    elif side in ("under", "no"): rec["under"] = o.get("price")
        new = list(agg.values())
        lines += new
        for r in new:
            hk = f"{r['pid'] or norm(r['player'])}|{r['market']}"
            hist.setdefault(hk, []).append([NOW.strftime("%Y-%m-%dT%H:%MZ"), r["book"], r["line"]])
        time.sleep(1)
    state["updated"] = NOW.isoformat()
    # prune old state
    state["events"] = {k: v for k, v in state["events"].items() if v.get("last", NOW.isoformat()) > (NOW - timedelta(days=10)).isoformat()}
    props = {"updated": NOW.isoformat() if fetched else props.get("updated"), "lines": lines}
    # prune history older than 14 days
    cutoff = (NOW - timedelta(days=14)).strftime("%Y-%m-%dT%H:%MZ")
    hist = {k: [p for p in v if p[0] >= cutoff] for k, v in hist.items()}
    hist = {k: v for k, v in hist.items() if v}
    save("props.json", props); save("odds_state.json", state); save("line_history.json", hist)
    note("odds", "ok", f"fetched {fetched} events; credits remaining {state.get('remaining')}")
    return props, state

# ---------------- alerts ----------------
def alert_new_lines(props, prev_count, players):
    """Optional: post to a Discord webhook when new sportsbook lines are loaded."""
    hook = os.environ.get("DISCORD_WEBHOOK_URL", "").strip()
    lines = props.get("lines", [])
    if not hook or not props.get("updated") or props["updated"] != NOW.isoformat():
        return
    new_events = sorted({(l["away"], l["home"]) for l in lines if l.get("away")})
    site = os.environ.get("SITE_URL", "https://aaugustin67-dotcom.github.io/propscout/")
    msg = (f"**PropScout:** new prop lines loaded ({len(lines)} lines) for " +
           ", ".join(f"{a} @ {h}" for a, h in new_events[:16]) + f"\nTop picks: {site}")
    try:
        req = urllib.request.Request(hook, data=json.dumps({"content": msg[:1900]}).encode(),
                                     headers={"Content-Type": "application/json", "User-Agent": "PropScout/1.0"})
        urllib.request.urlopen(req, timeout=20).read()
        note("discord", "ok", "alert sent")
    except Exception as e:
        note("discord", "error", str(e))

# ---------------- main ----------------
def main():
    sched = load_schedule()
    cur = current_season(sched)
    seasons = SEASONS or [cur - 2, cur - 1, cur]
    games = {}
    for g in sched:
        if int(g["season"]) not in seasons: continue
        ko = kickoff_utc(g)
        games[g["game_id"]] = {
            "id": g["game_id"], "season": int(g["season"]), "week": int(g["week"]), "type": g["game_type"],
            "date": g["gameday"], "time": g["gametime"], "day": g["weekday"], "ko": ko.isoformat() if ko else None,
            "home": g["home_team"], "away": g["away_team"],
            "hs": None if g["home_score"] in ("", "NA") else int(g["home_score"]),
            "as": None if g["away_score"] in ("", "NA") else int(g["away_score"]),
            "neutral": g["location"] == "Neutral", "spread": num(g["spread_line"]) if g["spread_line"] not in ("", "NA") else None,
            "total": num(g["total_line"]) if g["total_line"] not in ("", "NA") else None,
        }
    # upcoming slate: unplayed games kicking off from now-4h up to 8 days ahead (the current week)
    upcoming = [g for g in games.values() if g["hs"] is None and g["ko"]
                and NOW - timedelta(hours=4) <= datetime.fromisoformat(g["ko"]) <= NOW + timedelta(days=8)]
    if upcoming:
        wk = min((g["season"], g["week"]) for g in upcoming)
        upcoming = [g for g in upcoming if (g["season"], g["week"]) == wk]
    upcoming.sort(key=lambda g: g["ko"])

    rows = load_stats(seasons)
    if not rows:
        note("stats", "error", "no stats downloaded - keeping previous data")
        save("status.json", {"updated": NOW.isoformat(), "log": log, "ok": False}); return 1
    players, logs = {}, {}
    for r in rows:
        if r.get("position") not in POS or r.get("season_type") not in ("REG", "POST"): continue
        pid = r["player_id"]
        gid = r["game_id"]; g = games.get(gid)
        home = None
        if g: home = 0 if g["neutral"] else (1 if r["team"] == g["home"] else 0)
        st = [num(r.get(c)) for c in STAT_COLS]
        if not any(st): continue
        logs.setdefault(pid, []).append([int(r["season"]), int(r["week"]), gid, r["team"], r["opponent_team"], home] + st)
        p = players.setdefault(pid, {"id": pid, "name": r["player_display_name"], "pos": r["position"],
                                     "team": r["team"], "img": r.get("headshot_url") or "", "last": (0, 0)})
        key = (int(r["season"]), int(r["week"]))
        if key >= p["last"]:
            p["last"] = key; p["team"] = r["team"]; p["pos"] = r["position"]
            if r.get("headshot_url"): p["img"] = r["headshot_url"]
    for p in players.values():
        p["last"] = list(p["last"])
    for pid in logs:
        logs[pid].sort(key=lambda x: (x[0], x[1]))
    # Drop players with no game in last two seasons
    keep = {pid for pid, p in players.items() if p["last"][0] >= cur - 1}
    players = {k: v for k, v in players.items() if k in keep}
    logs = {k: v for k, v in logs.items() if k in keep}

    inj = load_injuries()
    if inj is None:
        inj = load_json(os.path.join(OUT, "injuries.json"), {"items": []}).get("items", [])
    by_norm = {}
    for pid, p in players.items():
        if p["last"][0] == cur or pid not in by_norm.values():
            by_norm.setdefault(norm(p["name"]), pid)
    prev_count = len(load_json(os.path.join(OUT, "props.json"), {"lines": []}).get("lines", []))
    props, ostate = load_odds(upcoming, by_norm)
    alert_new_lines(props, prev_count, players)

    save("stats.json", {"season": cur, "cols": ["season", "week", "game", "team", "opp", "home"] + STAT_COLS,
                        "players": players, "logs": logs})
    save("games.json", {"season": cur, "games": list(games.values()), "upcoming": upcoming})
    save("injuries.json", {"updated": NOW.isoformat(), "items": inj})
    if not os.path.exists(os.path.join(OUT, "props.json")):
        save("props.json", {"updated": None, "lines": []})
    if not os.path.exists(os.path.join(OUT, "line_history.json")):
        save("line_history.json", {})
    save("status.json", {"updated": NOW.isoformat(), "season": cur, "log": log, "ok": True,
                         "players": len(players), "rows": sum(len(v) for v in logs.values()),
                         "upcoming": len(upcoming),
                         "odds": {"has_key": ostate.get("has_key", False), "remaining": ostate.get("remaining"),
                                  "used": ostate.get("used"), "updated": props.get("updated")}})
    return 0

if __name__ == "__main__":
    sys.exit(main())
