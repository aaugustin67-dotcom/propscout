"""Grade every real sportsbook line we stored, after the game is final, to build
category base rates (market x Over/Under) from our own data.

archive: {key: {sport, pid, player, market, line, commence, event, over, under}}
results: {"cats": {market: {"over": [hit, miss, push], "under": [...]}}, "recent": [...], "graded": n}
"""
import json, os
from datetime import datetime, timedelta, timezone

def _load(path, default):
    try:
        with open(path) as f: return json.load(f)
    except Exception: return default

def _save(path, obj):
    with open(path, "w") as f: json.dump(obj, f, separators=(",", ":"))

def consensus(lines):
    """lines: list of book rows for one player+market+event -> consensus main line + best prices."""
    two = [l for l in lines if l.get("over") is not None]
    if not two: return None
    cnt = {}
    for l in two: cnt[l["line"]] = cnt.get(l["line"], 0) + 1
    mx = max(cnt.values()); cands = sorted(k for k, v in cnt.items() if v == mx)
    line = cands[len(cands) // 2]
    at = [l for l in two if l["line"] == line]
    return line, at

def archive_lines(sport, props_lines, archive_path):
    arc = _load(archive_path, {})
    by = {}
    for l in props_lines:
        if not l.get("pid"): continue
        by.setdefault((l["pid"], l["market"], l["event"]), []).append(l)
    added = 0
    for (pid, mk, ev), rows in by.items():
        c = consensus(rows)
        if not c: continue
        line, at = c
        k = f"{pid}|{mk}|{ev}"
        if k in arc and arc[k].get("graded"): continue
        if k not in arc: added += 1
        arc[k] = {"sport": sport, "pid": pid, "player": rows[0]["player"], "market": mk, "line": line,
                  "commence": rows[0]["commence"], "event": ev, "books": len(at)}
    _save(archive_path, arc)
    return added

def grade(archive_path, results_path, value_of, now=None, void_after_h=96, yes_only=()):
    """value_of(entry) -> stat value (number) if the player's game is in the stats, None if not yet / DNP."""
    now = now or datetime.now(timezone.utc)
    arc = _load(archive_path, {}); res = _load(results_path, {"cats": {}, "recent": [], "graded": 0, "voided": 0})
    done = 0
    for k, e in list(arc.items()):
        if e.get("graded"): continue
        ct = datetime.fromisoformat(e["commence"].replace("Z", "+00:00"))
        if now < ct + timedelta(hours=4): continue
        v = value_of(e)
        if v is None:
            if now > ct + timedelta(hours=void_after_h):
                e["graded"] = "void"; res["voided"] = res.get("voided", 0) + 1
            continue
        line = e["line"]
        cat = res["cats"].setdefault(e["market"], {"over": [0, 0, 0], "under": [0, 0, 0]})
        sides = ("over",) if e["market"] in yes_only else ("over", "under")
        for sd in sides:
            r = 2 if v == line else (0 if (v > line if sd == "over" else v < line) else 1)
            cat[sd][r] += 1
        e["graded"] = "ok"; e["value"] = v; done += 1
        res["recent"].append([e["commence"][:10], e["player"], e["market"], line, v])
    res["recent"] = res["recent"][-400:]
    res["graded"] = res.get("graded", 0) + done
    res["updated"] = now.isoformat()
    # prune graded archive entries older than 21 days
    cut = (now - timedelta(days=21)).isoformat()
    arc = {k: v for k, v in arc.items() if not (v.get("graded") and v["commence"] < cut)}
    _save(archive_path, arc); _save(results_path, res)
    return done, sum(1 for v in arc.values() if not v.get("graded"))
