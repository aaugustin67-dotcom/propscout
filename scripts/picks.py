"""Track record for the site's own Top Picks.

`scripts/picks.js` produces the picks with docs/app.js's scorer (so the ledger can
never drift from what the page ranked); this module merges them into
`docs/data/picks.json`, then grades each completed pick after the game is final:

    result  hit / loss / push / void        (anytime TD is yes/no, so no pushes)
    pnl     units at the price we recorded  (push + void = 0)
    close   the last line posted before kickoff (line_history.json)
    clv     side * (close - line), i.e. + means the line moved in our favour

A pick is recorded once per player + market + game: the first line the site
recommended is the line we grade, not whatever it drifted to later.
"""
import json
from datetime import datetime, timedelta

KEEP_DAYS = 45


def _load(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return default


def _save(path, obj):
    with open(path, "w") as f:
        json.dump(obj, f, separators=(",", ":"))


def dec(am):
    """American odds -> decimal payout (total return per 1 unit)."""
    if am is None:
        return None
    return 1 + am / 100 if am > 0 else 1 + 100 / (-am)


def merge(path, js_picks, now):
    """Add this refresh's picks, keeping the first line recorded for each prop."""
    d = _load(path, {"entries": [], "summary": {}})
    have = {e["key"] for e in d.get("entries", []) if e.get("key")}
    added = 0
    for p in js_picks:
        if not p.get("pid") or not p.get("event"):
            continue
        k = f"{p['pid']}|{p['market']}|{p['event']}"
        if k in have:
            continue
        have.add(k)
        d.setdefault("entries", []).append({
            "key": k, "pid": p["pid"], "player": p.get("player"), "market": p["market"],
            "line": p["line"], "side": p["side"], "price": p.get("price"), "book": p.get("book"),
            "score": p.get("score"), "event": p["event"], "commence": p["commence"],
            "recorded": now.isoformat(),
        })
        added += 1
    d["entries"].sort(key=lambda e: (e.get("commence") or "", e.get("pid") or ""))
    _save(path, d)
    return added


def _closing(hist, pid, market, commence):
    """Last line posted for this prop before kickoff."""
    rows = hist.get(f"{pid}|{market}") or []
    best = None
    for ts, _book, line in rows:
        if ts < commence and (best is None or ts > best[0]):
            best = (ts, line)
    return None if best is None else best[1]


def grade(path, value_of, hist, now, void_after_h=96):
    """Grade finished picks. value_of(entry) -> stat value, or None if not final/DNP."""
    d = _load(path, {"entries": [], "summary": {}})
    done = 0
    for e in d.get("entries", []):
        if e.get("graded"):
            continue
        try:
            ct = datetime.fromisoformat(e["commence"].replace("Z", "+00:00"))
        except Exception:
            e["graded"] = e["result"] = "void"
            continue
        if now < ct + timedelta(hours=4):
            continue
        v = value_of(e)
        if v is None:
            if now > ct + timedelta(hours=void_after_h):
                e.update(graded="void", result="void", pnl=0.0)
                done += 1
            continue
        line, side = e["line"], e["side"]
        if e["market"] == "anytime_td":
            res = "hit" if v >= 1 else "loss"
        elif v == line:
            res = "push"
        else:
            res = "hit" if (v > line) == (side > 0) else "loss"
        e["graded"] = "ok"
        e["value"] = v
        e["result"] = res
        if res == "push":
            e["pnl"] = 0.0
        else:
            dd = dec(e.get("price")) if e.get("price") is not None else None
            e["pnl"] = round((dd - 1) if res == "hit" and dd else (-1.0 if res == "loss" else (1.0 if res == "hit" else 0.0)), 3)
        close = _closing(hist, e["pid"], e["market"], e["commence"])
        if close is not None:
            e["close"] = close
            if e["market"] != "anytime_td":
                e["clv"] = round(side * (close - line), 2)
        done += 1
    # keep a rolling window so the file does not grow without bound
    cut = (now - timedelta(days=KEEP_DAYS)).isoformat()
    d["entries"] = [e for e in d.get("entries", []) if (e.get("commence") or now.isoformat()) >= cut]
    d["summary"] = summarise(d["entries"])
    d["updated"] = now.isoformat()
    _save(path, d)
    return done, d["summary"]


def summarise(entries):
    """Record, units won/lost, ROI and average closing-line value."""
    def block(rows):
        hits = sum(1 for e in rows if e.get("result") == "hit")
        losses = sum(1 for e in rows if e.get("result") == "loss")
        pushes = sum(1 for e in rows if e.get("result") == "push")
        voids = sum(1 for e in rows if e.get("result") == "void")
        raw = sum(e.get("pnl") or 0 for e in rows)   # ROI from unrounded units, or 2-dp display rounding leaks in
        pnl = round(raw, 2)
        staked = hits + losses + pushes
        clvs = [e["clv"] for e in rows if e.get("clv") is not None]
        return {
            "n": hits + losses + pushes, "hits": hits, "losses": losses, "pushes": pushes,
            "voids": voids, "units": pnl, "staked": staked,
            "roi": round(raw / staked, 4) if staked else None,
            "hit_rate": round(hits / (hits + losses + pushes), 4) if hits + losses + pushes else None,
            "clv": round(sum(clvs) / len(clvs), 2) if clvs else None, "clv_n": len(clvs),
        }
    out = block(entries)
    out["pending"] = sum(1 for e in entries if not e.get("graded") and not e.get("result"))
    by = {}
    for e in entries:
        m = e.get("market") or "?"
        by.setdefault(m, []).append(e)
    out["by_market"] = {m: block(rows) for m, rows in sorted(by.items())}
    return out
