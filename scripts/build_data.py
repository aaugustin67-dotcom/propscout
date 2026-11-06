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
             "receiving_yards", "receiving_tds", "sacks_suffered"]

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

def nfl_markets():
    """Optional env ODDS_NFL_MARKETS (comma list of Odds API keys) to trim NFL credit use; default all 7."""
    m = [x.strip() for x in os.environ.get("ODDS_NFL_MARKETS", "").split(",") if x.strip() in MARKETS]
    return m or list(MARKETS)

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

# ---------------- snap counts (who is a starter / key player) ----------------
GRP = {"QB":"QB","RB":"RB","HB":"RB","FB":"RB","WR":"WR","TE":"TE",
       "T":"OL","OT":"OL","G":"OL","OG":"OL","C":"OL","OL":"OL",
       "DE":"DL","DT":"DL","NT":"DL","DL":"DL","EDGE":"DL",
       "LB":"LB","OLB":"LB","ILB":"LB","MLB":"LB","CB":"CB","S":"S","FS":"S","SS":"S","DB":"S"}
KEY_SNAP = {"QB":.5,"RB":.35,"WR":.45,"TE":.45,"OL":.6,"DL":.5,"LB":.5,"CB":.6,"S":.6}

def load_snaps(season):
    url = f"https://github.com/nflverse/nflverse-data/releases/download/snap_counts/snap_counts_{season}.csv"
    try:
        raw, _ = fetch(url, timeout=120)
        rows = list(csv.DictReader(io.StringIO(raw.decode("utf-8"))))
    except Exception as e:
        note("snaps", "error", str(e)); return None
    if not rows:
        note("snaps", "error", "empty"); return None
    team_weeks, ply = {}, {}
    for r in rows:
        if r.get("game_type") not in ("REG", "POST"): continue
        t, wk = r["team"], int(r["week"])
        team_weeks.setdefault(t, set()).add(wk)
        pct = max(float(r.get("offense_pct") or 0), float(r.get("defense_pct") or 0))
        k = (norm(r["player"]), t)
        q = ply.setdefault(k, {"pos": r["position"], "w": {}, "g": {}})
        q["w"][wk] = pct
        q["g"][r["game_id"]] = round(float(r.get("offense_pct") or 0), 2)
    note("snaps", "ok", f"{len(rows)} rows, through week {max(max(v) for v in team_weeks.values())}")
    return {"team_weeks": {t: sorted(v) for t, v in team_weeks.items()}, "players": ply}

def enrich_injuries(inj, snaps):
    """Tag each injury with position group, season snap share and whether it is a fresh absence."""
    if not snaps: return inj
    for i in inj:
        grp = GRP.get((i.get("pos") or "").upper())
        i["grp"] = grp
        q = snaps["players"].get((norm(i.get("name")), i.get("team")))
        if not q:  # traded mid-season: fall back to a unique name match on any team
            c = [v for (n, t), v in snaps["players"].items() if n == norm(i.get("name"))]
            q = c[0] if len(c) == 1 else None
        if not q or not grp:
            i["snap"] = None; i["gp"] = 0; i["key"] = False; i["fresh"] = False; continue
        played = [v for v in q["w"].values() if v > 0]
        snap = sum(played) / len(played) if played else 0
        tw = snaps["team_weeks"].get(i["team"], [])
        last2 = tw[-2:]
        i["snap"] = round(snap, 2); i["gp"] = len(played)
        i["key"] = len(played) >= 2 and snap >= KEY_SNAP.get(grp, .6)
        # fresh = played meaningful snaps in one of the team's last two games, so his absence
        # is NOT yet reflected in teammates' recent stats
        i["fresh"] = any(q["w"].get(w, 0) >= .2 for w in last2)
    return inj

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
               f"&markets={','.join(nfl_markets())}")
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

# ---------------- free prop lines (Bovada public feed: no key, no credits) ----------------
BOVADA_URL = ("https://www.bovada.lv/services/sports/event/coupon/events/A/description/"
              "football/nfl?marketFilterId=prop&preMatchOnly=true&lang=en")
BOVADA_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
             "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
BOVADA_MARKETS = {  # Bovada market description prefix -> our key
    "Total Passing Yards": "pass_yds", "Total Passing Touchdowns": "pass_tds",
    "Total Completions": "completions", "Total Rushing Yards": "rush_yds",
    "Total Receiving Yards": "rec_yds", "Total Receptions": "receptions",
}
BOVADA_TD = "Anytime Touchdown Scorer"

def am_price(v):
    s = str(v if v is not None else "").strip().upper().replace("\u2212", "-").replace("\u2013", "-")
    if s in ("EVEN", "EV"): return 100
    return int(s) if re.fullmatch(r"[+-]?\d+", s) else None

def implied(am):
    if am is None: return None
    return 100.0 / (am + 100) if am > 0 else -am / (-am + 100)

def prop_name(s):
    """'Bijan Robinson (ATL)' / 'Kyle Pitts (ATL) - 1H' -> 'Bijan Robinson' / 'Kyle Pitts'."""
    n = re.sub(r"\s*-\s*(1H|2H|1Q|2Q|3Q|4Q|1st Half|2nd Half|1st Quarter|2nd Quarter|3rd Quarter|4th Quarter)$",
               "", (s or "").strip())
    return re.sub(r"\s*\([A-Za-z]{2,3}\)\s*$", "", n).strip()

def team_abbr(name):
    if not name: return None
    if name in TEAM_NAMES: return TEAM_NAMES[name]
    nick = {n.split()[-1]: a for n, a in TEAM_NAMES.items()}
    return nick.get(name.strip().split()[-1])

def bovada_main_line(sides):
    """Pick the book's main line from {handicap: {over, under}}: the two-way handicap closest to 50/50, then least vig."""
    two = {h: v for h, v in sides.items() if v.get("over") is not None and v.get("under") is not None}
    if not two: return None
    def hold(kv):  # most balanced two-way line first, then the lowest vig
        o, u = implied(kv[1]["over"]), implied(kv[1]["under"])
        return (abs(o - u), abs((o + u) - 1)) if o is not None and u is not None else (9, 9)
    h, s = min(two.items(), key=hold)
    return h, s

def load_odds_free(upcoming, players_by_norm):
    """Real sportsbook player props from Bovada's public JSON feed - free, no key, no credit budget.
    One request covers the whole slate. Writes the same props.json shape as the Odds API path."""
    props = load_json(os.path.join(OUT, "props.json"), {"updated": None, "lines": []})
    hist = load_json(os.path.join(OUT, "line_history.json"), {})
    state = {"has_key": False, "source": "bovada", "remaining": None, "used": None}
    try:
        req = urllib.request.Request(BOVADA_URL, headers={"User-Agent": BOVADA_UA, "Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=120) as r:
            data = json.loads(r.read())
    except Exception as e:
        note("odds_free", "error", f"bovada: {str(e)[:160]}")
        return props, state
    events = (data[0].get("events", []) if isinstance(data, list) and data else [])
    slate = {(g["away"], g["home"]): g for g in upcoming}
    # keep lines from other sources, drop yesterday's free lines
    lines = [l for l in props.get("lines", []) if l.get("book") != "Bovada"
             and l.get("commence") and datetime.fromisoformat(l["commence"].replace("Z", "+00:00")) > NOW - timedelta(hours=4)]
    new, games = [], set()
    for ev in events:
        parts = (ev.get("description") or "").split(" @ ")
        if len(parts) != 2: continue
        away, home = team_abbr(parts[0]), team_abbr(parts[1])
        g = slate.get((away, home))
        if not g or not ev.get("startTime"): continue
        commence = datetime.fromtimestamp(ev["startTime"] / 1000, timezone.utc).isoformat().replace("+00:00", "Z")
        for grp in ev.get("displayGroups") or []:
            for mk in grp.get("markets") or []:
                if mk.get("status") != "O" or (mk.get("period") or {}).get("description") != "Game": continue
                desc = mk.get("description") or ""
                base = {"book": "Bovada", "event": g["id"], "commence": commence, "home": home, "away": away}
                if desc == BOVADA_TD:  # yes/no market, line 0.5
                    for o in mk.get("outcomes") or []:
                        pn = prop_name(o.get("description"))
                        price = am_price((o.get("price") or {}).get("american"))
                        if o.get("type") != "X" or not pn or price is None or "Defense" in pn: continue
                        new.append(dict(base, player=pn, pid=players_by_norm.get(norm(pn)), market="anytime_td",
                                        line=0.5, over=price, under=None))
                    continue
                for label, market in BOVADA_MARKETS.items():
                    if not desc.startswith(label + " - "): continue
                    pn = prop_name(desc[len(label) + 3:])
                    if not pn: continue
                    sides = {}
                    for o in mk.get("outcomes") or []:
                        pr = o.get("price") or {}
                        try:
                            hp = float(pr.get("handicap"))
                        except (TypeError, ValueError):
                            continue
                        d = sides.setdefault(hp, {"over": None, "under": None})
                        if o.get("type") == "O": d["over"] = am_price(pr.get("american"))
                        elif o.get("type") == "U": d["under"] = am_price(pr.get("american"))
                    main = bovada_main_line(sides)
                    if not main: continue
                    hp, s = main
                    new.append(dict(base, player=pn, pid=players_by_norm.get(norm(pn)), market=market,
                                    line=int(hp) if float(hp).is_integer() else round(hp, 1),
                                    over=s["over"], under=s["under"]))
                    break
        games.add(g["id"])
    seen, out = set(), []
    for r in new:  # one line per player+market
        k = (r["pid"] or norm(r["player"]), r["market"])
        if k in seen: continue
        seen.add(k); out.append(r)
    for r in out:
        hk = f"{r['pid'] or norm(r['player'])}|{r['market']}"
        h = hist.setdefault(hk, [])
        if not h or h[-1][2] != r["line"]:  # only log a change, so the feed does not spam history
            h.append([NOW.strftime("%Y-%m-%dT%H:%MZ"), "Bovada", r["line"]])
    cutoff = (NOW - timedelta(days=14)).strftime("%Y-%m-%dT%H:%MZ")
    hist = {k: [p for p in v if p[0] >= cutoff] for k, v in hist.items()}
    hist = {k: v for k, v in hist.items() if v}
    props = {"updated": NOW.isoformat() if out else props.get("updated"), "lines": lines + out}
    save("props.json", props); save("line_history.json", hist)
    note("odds_free", "ok" if out else "skipped",
         f"Bovada: {len(out)} lines over {len(games)} games (free, no key)" if out else "no props posted yet")
    return props, state

# ---------------- second free book: DraftKings public sportsbook API (scraped) ----------------
DK_BASE = "https://sportsbook-nash.draftkings.com/api/sportscontent/dkusnj/v1"
DK_LEAGUE = "88808"
DK_MARKETS = {  # our market key -> (DraftKings categoryId, subcategoryId) for the real two-way O/U board
    "pass_yds": (1000, 9524), "pass_tds": (1000, 9525), "completions": (1000, 9522),
    "rush_yds": (1001, 9514), "rec_yds": (1342, 14114), "receptions": (1342, 14115),
}
DK_TD = (1003, 12438)  # Anytime TD Scorer: one price per player, no under side
DK_SUFFIX = {  # DraftKings market-name suffix -> our key
    "Passing Yards": "pass_yds", "Passing Touchdowns": "pass_tds", "Completions": "completions",
    "Rushing Yards": "rush_yds", "Receiving Yards": "rec_yds", "Receptions": "receptions",
}

def has_curl_cffi():
    try:
        import curl_cffi  # noqa: F401
        return True
    except ImportError:
        return False

def dk_get(path):
    """DraftKings sits behind Akamai: plain urllib gets 403, so use curl_cffi's Chrome TLS when installed."""
    url = DK_BASE + path
    if has_curl_cffi():
        from curl_cffi import requests as creq
        r = creq.get(url, impersonate="chrome", timeout=45, headers={"Accept": "application/json"})
        if r.status_code != 200: raise RuntimeError(f"HTTP {r.status_code}")
        return r.json()
    raw, _ = fetch(url, timeout=60, tries=1)
    return json.loads(raw)

def dk_event_teams(events):
    """{'34118128': ('CIN','ATL')} from 'CIN Bengals @ ATL Falcons'."""
    out = {}
    for e in events or []:
        parts = (e.get("name") or "").split(" @ ")
        if len(parts) != 2: continue
        a, h = parts[0].split()[0], parts[1].split()[0]
        out[str(e.get("id"))] = (DK_ABBR.get(a, a), DK_ABBR.get(h, h))
    return out

def load_odds_dk(upcoming, players_by_norm):
    """Second keyless book: DraftKings' public NFL prop board (7 markets, one request each)."""
    props = load_json(os.path.join(OUT, "props.json"), {"updated": None, "lines": []})
    state = {"has_key": False, "source": None, "remaining": None, "used": None}
    if not has_curl_cffi():
        note("odds_dk", "skipped", "curl_cffi not installed - DraftKings needs browser TLS, Bovada lines only")
        return props, state
    slate = {(g["away"], g["home"]): g for g in upcoming}
    lines = [l for l in props.get("lines", []) if l.get("book") != "DraftKings"]
    new, games = [], set()
    try:
        for market, (cid, sid) in list(DK_MARKETS.items()) + [("anytime_td", DK_TD)]:
            data = dk_get(f"/leagues/{DK_LEAGUE}/categories/{cid}/subcategories/{sid}")
            teams = dk_event_teams(data.get("events"))
            by_market = {}
            for sel in data.get("selections") or []:
                by_market.setdefault(sel.get("marketId"), []).append(sel)
            for mk in data.get("markets") or []:
                ev = teams.get(str(mk.get("eventId")))
                g = slate.get(ev) if ev else None
                if not g: continue
                base = {"book": "DraftKings", "event": g["id"], "commence": g["ko"],
                        "home": g["home"], "away": g["away"]}
                sel = by_market.get(mk.get("id")) or []
                if market == "anytime_td":
                    for x in sel:
                        name = (x.get("label") or "").strip()
                        price = am_price((x.get("displayOdds") or {}).get("american"))
                        if not name or price is None: continue
                        new.append(dict(base, player=name, pid=players_by_norm.get(norm(name)),
                                        market="anytime_td", line=0.5, over=price, under=None))
                    continue
                full = re.sub(r"\s+O/U$", "", mk.get("name") or "")
                pn, key = None, None
                for suffix, k in DK_SUFFIX.items():
                    if full.endswith(" " + suffix):
                        key, pn = k, full[: -len(suffix) - 1].strip()
                        break
                if key != market or not pn: continue
                sides = {}
                for x in sel:
                    side = (x.get("label") or "").strip().lower()
                    if side not in ("over", "under"): continue
                    try: hp = float(x.get("points"))
                    except (TypeError, ValueError): continue
                    price = am_price((x.get("displayOdds") or {}).get("american"))
                    sides.setdefault(hp, {"over": None, "under": None})[side] = price
                main = bovada_main_line(sides)
                if not main: continue
                hp, sd = main
                new.append(dict(base, player=pn, pid=players_by_norm.get(norm(pn)), market=market,
                                line=int(hp) if float(hp).is_integer() else round(hp, 1),
                                over=sd["over"], under=sd["under"]))
                games.add(g["id"])
    except Exception as e:
        note("odds_dk", "error", f"draftkings: {str(e)[:140]}")
        return props, state
    seen, out = set(), []
    for r in new:  # one line per player+market
        k = (r["pid"] or norm(r["player"]), r["market"])
        if k in seen: continue
        seen.add(k); out.append(r)
    props = {"updated": NOW.isoformat() if out else props.get("updated"), "lines": lines + out}
    save("props.json", props)
    if out:
        state["source"] = "draftkings"
        note("odds_dk", "ok", f"DraftKings: {len(out)} lines over {len(games)} games (scraped, no key)")
    else:
        note("odds_dk", "skipped", "no DraftKings props matched this slate")
    return props, state

# ---------------- betting splits (DraftKings Network public page, game lines only) ----------------
DK_ABBR = {"LAR": "LA", "WSH": "WAS", "JAC": "JAX", "LVR": "LV"}
def load_splits(eg="88808", out="splits.json", names=None, label="NFL"):
    """% handle and % bets for moneyline / spread / total from DraftKings' free public splits page.
    Allowed by robots.txt; one or two page loads per run. Player-prop splits are not published there."""
    base = f"https://dknetwork.draftkings.com/draftkings-sportsbook-betting-splits/?tb_eg={eg}&tb_edate=n7days&tb_emt=0"
    games, seen = [], set()
    strip = lambda x: re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", x)).replace("\u2212", "-").strip()
    for page in range(1, 5):
        try:
            raw, _ = fetch(base + (f"&tb_page={page}" if page > 1 else ""), timeout=30, tries=2)
        except Exception as e:
            note("splits", "error", str(e)); break
        h = raw.decode("utf-8", "ignore")
        blocks = h.split('class="tb-se ')[1:]
        new = 0
        for b in blocks:
            t = re.search(r"<h5[^>]*>(.*?)</h5>", b, re.S)
            parts = strip(t.group(1)).split(" @ ") if t else []
            if len(parts) != 2: continue
            nick = {n.split()[-1]: a for n, a in (names or TEAM_NAMES).items()}
            away, home = (nick.get(x.split()[-1]) for x in parts)
            if not away or not home: continue
            if (away, home) in seen: continue
            seen.add((away, home)); new += 1
            when = re.search(r"</h5>\s*<span[^>]*>([^<]+)</span>", b)
            g = {"away": away, "home": home, "when": when.group(1).strip() if when else None, "markets": {}}
            for mk in b.split('class="tb-se-head')[1:]:
                mname = re.search(r'<div class="flex-1">(.*?)</div>', mk, re.S)
                if not mname: continue  # page markup without a market name: skip instead of failing the run
                name = strip(mname.group(1))
                rows = []
                for r in mk.split('class="tb-sodd')[1:]:
                    lab = re.search(r'tb-slipline[^>]*>(.*?)</div>', r, re.S)
                    odds = re.search(r'tb-odd-s[^>]*>(.*?)</a>', r, re.S)
                    pcts = re.findall(r'<div class="flex-1">\s*(\d+)%', r)
                    if not lab or len(pcts) < 2: continue
                    o = strip(odds.group(1)) if odds else ""
                    rows.append({"side": strip(lab.group(1)), "odds": int(o) if re.fullmatch(r"[+-]?\d+", o) else None,
                                 "handle": int(pcts[0]), "bets": int(pcts[1])})
                if rows: g["markets"][name.lower()] = rows
            if g["markets"]: games.append(g)
        if not new or f"tb_page={page + 1}" not in h: break
        time.sleep(1)
    if games:
        note("splits", "ok", f"{len(games)} {label} games (DraftKings handle/bets %)")
        save(out, {"updated": NOW.isoformat(), "source": "DraftKings Sportsbook public betting splits (dknetwork.draftkings.com)", "games": games})
    else:
        note("splits", "skipped", "no splits parsed - keeping previous")

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
    snaps = load_snaps(cur)
    inj = enrich_injuries(inj, snaps)
    # per-game offensive snap share for skill players (player page game log)
    snap_out = {}
    prev = load_snaps(cur - 1)
    for src in [x for x in (snaps, prev) if x]:
        for pid, p in players.items():
            teams = {r[3] for r in logs.get(pid, [])}
            for t in teams:
                q = src["players"].get((norm(p["name"]), t))
                if q: snap_out.setdefault(pid, {}).update(q["g"])
    save("snaps.json", snap_out)
    by_norm = {}
    for pid, p in players.items():
        if p["last"][0] == cur or pid not in by_norm.values():
            by_norm.setdefault(norm(p["name"]), pid)
    prev_count = len(load_json(os.path.join(OUT, "props.json"), {"lines": []}).get("lines", []))
    # free real lines first (Bovada), then DraftKings as a second book; both need no key
    props, ostate = load_odds_free(upcoming, by_norm)
    props, dstate = load_odds_dk(upcoming, by_norm)
    sources = [x for x in (ostate.get("source"), dstate.get("source")) if x]
    if os.environ.get("ODDS_API_KEY", "").strip():
        # optional: add FanDuel/BetMGM/BetRivers prices on top of the free books
        props, kstate = load_odds(upcoming, by_norm)
        if kstate.get("has_key"):
            ostate = kstate
            sources.append("the-odds-api")
    ostate = dict(ostate, source="+".join(sources) if sources else None)
    # grade stored real lines once games are final -> category base rates
    try:
        import grading
        COLIDX = {c: i + 6 for i, c in enumerate(STAT_COLS)}
        MV = {"pass_yds": ["passing_yards"], "pass_tds": ["passing_tds"], "completions": ["completions"],
              "rush_yds": ["rushing_yards"], "rec_yds": ["receiving_yards"], "receptions": ["receptions"],
              "anytime_td": ["rushing_tds", "receiving_tds"]}
        def value_of(e):
            ct = datetime.fromisoformat(e["commence"].replace("Z", "+00:00"))
            for r in logs.get(e["pid"], []):
                g = games.get(r[2])
                if g and g["ko"] and abs((datetime.fromisoformat(g["ko"]) - ct).total_seconds()) < 8 * 3600:
                    v = sum(r[COLIDX[c]] for c in MV[e["market"]])
                    return (1 if v >= 1 else 0) if e["market"] == "anytime_td" else v
            return None
        added = grading.archive_lines("nfl", props.get("lines", []), os.path.join(OUT, "line_archive.json"))
        done, pend = grading.grade(os.path.join(OUT, "line_archive.json"), os.path.join(OUT, "results.json"),
                                   value_of, now=NOW, yes_only=("anytime_td",))
        note("grading", "ok", f"archived {added} new lines; graded {done}; {pend} waiting for final stats")
    except Exception as e:
        note("grading", "error", str(e))
    load_splits()
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
                                  "used": ostate.get("used"), "source": ostate.get("source"),
                                  "updated": props.get("updated")}})
    return 0

if __name__ == "__main__":
    sys.exit(main())
