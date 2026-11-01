#!/usr/bin/env python3
"""PropScout NHL data builder.

Free sources: NHL public API (api-web.nhle.com) boxscores, schedule, rosters, player game logs;
ESPN NHL injuries; DraftKings public betting splits. Optional: The Odds API NHL player props under a
strict credit budget that always leaves enough for the NFL slate (shared 500/month free tier).
Writes docs/data/nhl/*.json. Boxscores are cached in stats.json, so each run only fetches new games.
"""
import json, os, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone, timedelta
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_data as B
import grading

NOW = B.NOW
OUT = os.path.join(B.OUT, "nhl"); os.makedirs(OUT, exist_ok=True)
API = "https://api-web.nhle.com/v1"
TEAMS = {
 "Anaheim Ducks":"ANA","Boston Bruins":"BOS","Buffalo Sabres":"BUF","Calgary Flames":"CGY","Carolina Hurricanes":"CAR",
 "Chicago Blackhawks":"CHI","Colorado Avalanche":"COL","Columbus Blue Jackets":"CBJ","Dallas Stars":"DAL","Detroit Red Wings":"DET",
 "Edmonton Oilers":"EDM","Florida Panthers":"FLA","Los Angeles Kings":"LAK","Minnesota Wild":"MIN","Montreal Canadiens":"MTL",
 "Montréal Canadiens":"MTL","Nashville Predators":"NSH","New Jersey Devils":"NJD","New York Islanders":"NYI","New York Rangers":"NYR",
 "Ottawa Senators":"OTT","Philadelphia Flyers":"PHI","Pittsburgh Penguins":"PIT","San Jose Sharks":"SJS","Seattle Kraken":"SEA",
 "St. Louis Blues":"STL","St Louis Blues":"STL","Tampa Bay Lightning":"TBL","Toronto Maple Leafs":"TOR","Utah Mammoth":"UTA",
 "Utah Hockey Club":"UTA","Vancouver Canucks":"VAN","Vegas Golden Knights":"VGK","Washington Capitals":"WSH","Winnipeg Jets":"WPG",
}
SK_COLS = ["goals", "assists", "points", "sog", "toi", "ppg", "ppp", "blk", "hits", "pim"]
G_COLS = ["saves", "ga", "sa", "start", "toi", "win"]
MARKETS = {"player_shots_on_goal": "sog", "player_points": "points"}   # 2 credits / game
log = []
def note(src, status, msg=""):
    log.append({"source": src, "status": status, "message": msg, "at": NOW.isoformat()})
    print(f"[nhl:{src}] {status} {msg}", file=sys.stderr)

def j(url, timeout=30):
    raw, hdr = B.fetch(url, timeout=timeout, tries=3)
    return json.loads(raw), hdr

def save(name, obj):
    with open(os.path.join(OUT, name), "w") as f: json.dump(obj, f, separators=(",", ":"))

def load(name, default):
    return B.load_json(os.path.join(OUT, name), default)

def toi_min(t):
    try: m, s = t.split(":"); return round(int(m) + int(s) / 60, 1)
    except Exception: return 0

def season_start_year():
    d, _ = j(f"{API}/schedule/now")
    return int(d["regularSeasonStartDate"][:4]), d

def crawl_schedule(start, end):
    games = {}
    day = start
    while day <= end:
        try: d, _ = j(f"{API}/schedule/{day.strftime('%Y-%m-%d')}")
        except Exception as e: note("schedule", "error", str(e)); break
        for w in d.get("gameWeek", []):
            for g in w.get("games", []):
                if g.get("gameType") not in (2, 3): continue
                games[g["id"]] = {"id": g["id"], "season": int(str(g["season"])[:4]), "type": "REG" if g["gameType"] == 2 else "POST",
                                  "date": w["date"], "ko": g["startTimeUTC"].replace("Z", "+00:00"),
                                  "home": g["homeTeam"]["abbrev"], "away": g["awayTeam"]["abbrev"],
                                  "hs": g["homeTeam"].get("score") if g.get("gameState") in ("OFF", "FINAL") else None,
                                  "as": g["awayTeam"].get("score") if g.get("gameState") in ("OFF", "FINAL") else None,
                                  "state": g.get("gameState")}
        day += timedelta(days=7)
    return games

def box(gid):
    try: d, _ = j(f"{API}/gamecenter/{gid}/boxscore")
    except Exception as e: return gid, None
    if d.get("gameState") not in ("OFF", "FINAL"): return gid, None
    return gid, d

def main():
    cur, sched_now = season_start_year()
    prev = cur - 1
    st = load("stats.json", {"season": cur, "cols": SK_COLS, "gcols": G_COLS, "players": {}, "logs": {}, "done": []})
    gm = load("games.json", {"games": []})
    games = {g["id"]: g for g in gm.get("games", [])}
    done = set(st.get("done", []))
    players, logs = st["players"], st["logs"]
    # schedule: current season from start to +8 days; previous season once (regular season ids are sequential)
    start = datetime.strptime(sched_now["regularSeasonStartDate"], "%Y-%m-%d")
    games.update(crawl_schedule(start, datetime.now() + timedelta(days=8)))
    if not any(g["season"] == prev for g in games.values()):
        pstart = datetime(prev, 10, 1)
        games.update(crawl_schedule(pstart, datetime(prev + 1, 4, 20)))
    note("schedule", "ok", f"{len(games)} games known")
    todo = [gid for gid, g in games.items() if g["hs"] is not None and gid not in done and g["season"] >= prev]
    new_players = set()
    with ThreadPoolExecutor(8) as ex:
        for gid, d in ex.map(box, todo):
            if not d: continue
            g = games[gid]
            for side, opp_side, home in (("awayTeam", "homeTeam", 0), ("homeTeam", "awayTeam", 1)):
                team, opp = d[side]["abbrev"], d[opp_side]["abbrev"]
                pg = d["playerByGameStats"][side]
                for grp_key, grp in (("forwards", "F"), ("defense", "D"), ("goalies", "G")):
                    for p in pg.get(grp_key, []):
                        pid = str(p["playerId"])
                        pl = players.setdefault(pid, {"id": pid, "name": p["name"]["default"], "pos": grp, "team": team, "img": "", "last": [0, ""]})
                        if grp == "G":
                            if toi_min(p.get("toi")) <= 0: continue
                            row = [g["season"], gid, g["date"], team, opp, home, p.get("saves", 0), p.get("goalsAgainst", 0),
                                   p.get("shotsAgainst", 0), 1 if p.get("starter") else 0, toi_min(p.get("toi")), 1 if p.get("decision") == "W" else 0]
                        else:
                            row = [g["season"], gid, g["date"], team, opp, home, p.get("goals", 0), p.get("assists", 0), p.get("points", 0),
                                   p.get("sog", 0), toi_min(p.get("toi")), p.get("powerPlayGoals", 0), None, p.get("blockedShots", 0),
                                   p.get("hits", 0), p.get("pim", 0)]
                        logs.setdefault(pid, []).append(row)
                        if [g["season"], g["date"]] >= list(pl.get("last") or [0, ""]):
                            pl["last"] = [g["season"], g["date"]]; pl["team"] = team
                        if grp != "G": new_players.add((pid, g["season"]))
            done.add(gid)
    note("boxscores", "ok", f"{len(todo)} new final games fetched, {len(done)} cached")
    # power-play points per game come only from the player game-log endpoint
    need = {(pid, s) for pid, s in new_players}
    for pid, rows in logs.items():
        if players.get(pid, {}).get("pos") != "G" and any(r[12] is None for r in rows):
            for r in rows:
                if r[12] is None: need.add((pid, r[0]))
    def gl(ps):
        pid, s = ps
        try: d, _ = j(f"{API}/player/{pid}/game-log/{s}{s+1}/2", timeout=20); return ps, {x["gameId"]: x.get("powerPlayPoints", 0) for x in d.get("gameLog", [])}
        except Exception: return ps, None
    got = 0
    with ThreadPoolExecutor(8) as ex:
        for (pid, s), m in ex.map(gl, sorted(need)):
            if m is None: continue
            got += 1
            for r in logs.get(pid, []):
                if r[0] == s and r[12] is None: r[12] = m.get(r[1], 0)
    note("pp_points", "ok", f"{got} player game logs")
    # rosters: full names, positions, headshots, current team
    teams = sorted({g["home"] for g in games.values() if g["season"] == cur})
    def ros(t):
        try: d, _ = j(f"{API}/roster/{t}/current"); return t, d
        except Exception: return t, None
    with ThreadPoolExecutor(8) as ex:
        for t, d in ex.map(ros, teams):
            if not d: continue
            for k, grp in (("forwards", "F"), ("defensemen", "D"), ("goalies", "G")):
                for p in d.get(k, []):
                    pid = str(p["id"])
                    pl = players.setdefault(pid, {"id": pid, "pos": grp, "last": [0, ""]})
                    pl["name"] = f'{p["firstName"]["default"]} {p["lastName"]["default"]}'
                    pl["team"] = t; pl["pos"] = grp; pl["pcode"] = p.get("positionCode"); pl["img"] = p.get("headshot", "")
                    pl["roster"] = 1
    for rows in logs.values(): rows.sort(key=lambda r: (r[0], r[2]))
    for pid, rows in logs.items():
        if pid in players and rows and not players[pid].get("roster"): players[pid]["team"] = rows[-1][3]
    # keep players with games in the two seasons
    st = {"season": cur, "cols": ["season", "game", "date", "team", "opp", "home"] + SK_COLS,
          "gcols": ["season", "game", "date", "team", "opp", "home"] + G_COLS,
          "players": {k: v for k, v in players.items() if k in logs}, "logs": logs, "done": sorted(done)}
    upcoming = sorted([g for g in games.values() if g["hs"] is None and g["season"] == cur and
                       NOW - timedelta(hours=4) <= datetime.fromisoformat(g["ko"]) <= NOW + timedelta(hours=40)], key=lambda g: g["ko"])
    save("stats.json", st)
    save("games.json", {"season": cur, "games": [g for g in games.values() if g["season"] >= prev], "upcoming": upcoming})

    # ---- key players + injuries ----
    by_norm = {}
    for pid, p in st["players"].items():
        if p.get("roster") or pid not in by_norm.values(): by_norm.setdefault(B.norm(p["name"]), pid)
    team_games = {}
    for g in games.values():
        if g["season"] == cur and g["hs"] is not None:
            for t in (g["home"], g["away"]): team_games.setdefault(t, []).append(g)
    for t in team_games: team_games[t].sort(key=lambda g: g["ko"])
    def usage(pid):
        rows = [r for r in logs.get(pid, []) if r[0] == cur]
        if not rows: return None
        p = st["players"][pid]
        if p["pos"] == "G": return {"gp": len(rows), "starts": sum(r[9] for r in rows[-10:]), "toi": 0, "ppp": 0}
        return {"gp": len(rows), "toi": round(sum(r[10] for r in rows[-10:]) / len(rows[-10:]), 1),
                "ppp": sum((r[12] or 0) for r in rows), "pts": sum(r[8] for r in rows)}
    U = {pid: usage(pid) for pid in st["players"]}
    rank = {}
    for t in team_games:
        for grp, n, keyf in (("F", 6, "toi"), ("D", 4, "toi"), ("G", 1, "starts")):
            ids = [pid for pid, p in st["players"].items() if p["team"] == t and p["pos"] == grp and U.get(pid)]
            ids.sort(key=lambda x: -U[x][keyf])
            for i, pid in enumerate(ids): rank[pid] = (grp, i + 1, i < n)
        pp = sorted([pid for pid, p in st["players"].items() if p["team"] == t and p["pos"] != "G" and U.get(pid)], key=lambda x: -U[x]["ppp"])[:5]
        for pid in pp:
            if U[pid]["ppp"] >= 2: rank[pid] = rank.get(pid, ("F", 99, False)) + ("pp1",)
    try:
        raw, _ = B.fetch("https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/injuries")
        data = json.loads(raw); inj = []
        for t in data.get("injuries", []):
            team = TEAMS.get(t.get("displayName"), t.get("displayName"))
            for i in t.get("injuries", []):
                a = i.get("athlete", {}) or {}
                inj.append({"team": team, "name": a.get("displayName"), "pos": ((a.get("position") or {}).get("abbreviation")),
                            "status": i.get("status"), "detail": (i.get("shortComment") or "")[:220], "date": i.get("date")})
        note("injuries", "ok", f"{len(inj)} entries")
    except Exception as e:
        note("injuries", "error", str(e)); inj = load("injuries.json", {"items": []}).get("items", [])
    for i in inj:
        pid = by_norm.get(B.norm(i["name"]))
        p = st["players"].get(pid) if pid else None
        i["pid"] = pid
        grp = p["pos"] if p else ({"G": "G", "D": "D"}.get((i.get("pos") or "").upper(), "F"))
        i["grp"] = grp
        rk = rank.get(pid) if pid else None
        u = U.get(pid) if pid else None
        i["key"] = bool(rk and rk[2])
        i["pp1"] = bool(rk and "pp1" in rk)
        if i["pp1"]: i["key"] = True
        i["role"] = (f"top-{6 if grp=='F' else 4 if grp=='D' else 1} {grp}" if rk and rk[2] else "") + (" · PP1" if i["pp1"] else "")
        i["role"] = i["role"].strip(" ·") or None
        if grp == "G" and rk and rk[2]: i["role"] = "starting G"
        i["toi"] = u["toi"] if u else None
        i["snap"] = None
        tg = team_games.get(i["team"], [])[-2:]
        played = {r[1] for r in logs.get(pid, [])} if pid else set()
        i["fresh"] = any(g["id"] in played for g in tg)
    save("injuries.json", {"updated": NOW.isoformat(), "items": inj})

    # ---- odds (budgeted) ----
    props = load("props.json", {"updated": None, "lines": []})
    props["lines"] = [l for l in props.get("lines", []) if datetime.fromisoformat(l["commence"].replace("Z", "+00:00")) > NOW - timedelta(hours=4)]
    ost = load("odds_state.json", {"events": {}, "month": None, "used": 0})
    month = NOW.strftime("%Y-%m")
    if ost.get("month") != month: ost["month"] = month; ost["used"] = 0
    cap = int(os.environ.get("NHL_MONTHLY_CAP", "60"))
    key = os.environ.get("ODDS_API_KEY", "").strip()
    nfl_state = B.load_json(os.path.join(B.OUT, "odds_state.json"), {})
    nfl_games = B.load_json(os.path.join(B.OUT, "games.json"), {"games": []}).get("games", [])
    per_nfl = len(B.nfl_markets())
    nfl_left_games = [g for g in nfl_games if g.get("ko") and g["ko"][:7] == month and g.get("hs") is None
                      and datetime.fromisoformat(g["ko"]) > NOW + timedelta(hours=30)]
    reserve = per_nfl * len(nfl_left_games) + int(os.environ.get("ODDS_MIN_REMAINING", "30"))
    remaining = int(nfl_state.get("remaining") or 0)
    allow = max(0, min(cap - ost["used"], remaining - reserve))
    ost.update({"cap": cap, "reserve": reserve, "remaining": remaining, "allow": allow, "has_key": bool(key)})
    fetched = 0
    if key:
        try:
            evs, _ = j(f"https://api.the-odds-api.com/v4/sports/icehockey_nhl/events?apiKey={key}")
        except Exception as e:
            note("odds", "error", "events: " + str(e).replace(key, "***")); evs = []
        win = float(os.environ.get("NHL_ODDS_WINDOW_HOURS", "8"))
        # priority: games with the best combined team point% (marquee games first)
        try:
            sd, _ = j(f"{API}/standings/now"); ppct = {s["teamAbbrev"]["default"]: s.get("pointPctg", .5) for s in sd["standings"]}
        except Exception: ppct = {}
        cand = []
        for ev in evs:
            ct = datetime.fromisoformat(ev["commence_time"].replace("Z", "+00:00"))
            if not (NOW < ct <= NOW + timedelta(hours=win)): continue
            if ost["events"].get(ev["id"], {}).get("fetches"): continue
            h, a = TEAMS.get(ev["home_team"]), TEAMS.get(ev["away_team"])
            cand.append((-(ppct.get(h, .5) + ppct.get(a, .5)), ev))
        cand.sort(key=lambda x: x[0])
        for _, ev in cand:
            if allow < len(MARKETS):
                note("odds", "budget", f"NHL allowance {allow} credits (cap {cap}/mo, used {ost['used']}, NFL reserve {reserve}) - {len(cand)-fetched} games on model lines")
                break
            try:
                raw, hdr = B.fetch(f"https://api.the-odds-api.com/v4/sports/icehockey_nhl/events/{ev['id']}/odds?apiKey={key}"
                                   f"&regions=us&oddsFormat=american&markets={','.join(MARKETS)}")
            except Exception as e:
                note("odds", "error", f"{ev['id']}: " + str(e).replace(key, "***")); continue
            h = {k.lower(): v for k, v in hdr.items()}
            cost = int(h.get("x-requests-last", len(MARKETS)) or 0)
            ost["used"] += cost; allow -= cost
            nfl_state["remaining"] = h.get("x-requests-remaining", nfl_state.get("remaining"))
            nfl_state["used"] = h.get("x-requests-used", nfl_state.get("used"))
            data = json.loads(raw)
            if not any(bk.get("markets") for bk in data.get("bookmakers", [])):
                continue
            ost["events"][ev["id"]] = {"fetches": 1, "last": NOW.isoformat()}; fetched += 1
            props["lines"] = [l for l in props["lines"] if l["event"] != ev["id"]]
            agg = {}
            for bk in data.get("bookmakers", []):
                for m in bk.get("markets", []):
                    mk = MARKETS.get(m["key"])
                    if not mk: continue
                    for o in m.get("outcomes", []):
                        pn = o.get("description") or ""
                        k2 = (B.norm(pn), mk, bk["key"], o.get("point"))
                        rec = agg.setdefault(k2, {"player": pn, "pid": by_norm.get(B.norm(pn)), "market": mk, "book": bk["title"],
                                                  "line": o.get("point") if o.get("point") is not None else 0.5, "over": None, "under": None,
                                                  "event": ev["id"], "commence": ev["commence_time"],
                                                  "home": TEAMS.get(data.get("home_team")), "away": TEAMS.get(data.get("away_team"))})
                        sd_ = (o.get("name") or "").lower()
                        if sd_ == "over": rec["over"] = o.get("price")
                        elif sd_ == "under": rec["under"] = o.get("price")
            props["lines"] += list(agg.values())
            time.sleep(1)
        if fetched: props["updated"] = NOW.isoformat()
        # write back the shared credit counter so the NFL page shows the true balance
        if fetched: B.save("odds_state.json", nfl_state)
    note("odds", "ok" if key else "skipped", f"NHL: fetched {fetched} games; NHL used {ost['used']}/{cap} this month; allowance left {allow}; NFL reserve {reserve}" if key else "no key")
    ost["allow"] = allow
    ost["events"] = {k: v for k, v in ost["events"].items() if v.get("last", "") > (NOW - timedelta(days=10)).isoformat()}
    save("odds_state.json", ost); save("props.json", props)
    if not os.path.exists(os.path.join(OUT, "line_history.json")): save("line_history.json", {})

    # ---- grading ----
    try:
        MV = {"sog": 9, "points": 8}
        def value_of(e):
            ct = datetime.fromisoformat(e["commence"].replace("Z", "+00:00"))
            for r in logs.get(e["pid"], []):
                g = games.get(r[1])
                if g and abs((datetime.fromisoformat(g["ko"]) - ct).total_seconds()) < 8 * 3600:
                    return r[MV[e["market"]]]
            return None
        added = grading.archive_lines("nhl", props["lines"], os.path.join(OUT, "line_archive.json"))
        dn, pend = grading.grade(os.path.join(OUT, "line_archive.json"), os.path.join(OUT, "results.json"), value_of, now=NOW, void_after_h=48)
        note("grading", "ok", f"archived {added}; graded {dn}; {pend} pending")
    except Exception as e:
        note("grading", "error", str(e))
    # ---- betting splits ----
    B.log.clear()
    B.load_splits(eg="42133", out="nhl/splits.json", names=TEAMS, label="NHL")
    log.extend(B.log)
    save("status.json", {"updated": NOW.isoformat(), "season": cur, "log": log, "ok": True, "players": len(st["players"]),
                         "rows": sum(len(v) for v in logs.values()), "upcoming": len(upcoming),
                         "odds": {"has_key": bool(key), "remaining": nfl_state.get("remaining"), "used": nfl_state.get("used"),
                                  "updated": props.get("updated"), "nhl_used": ost["used"], "nhl_cap": cap, "nfl_reserve": reserve, "nhl_allow": allow}})
    return 0

if __name__ == "__main__":
    sys.exit(main())
