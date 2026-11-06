# PropScout — NFL player prop research

A personal-use NFL player prop research app: hit rates, matchups, line comparison and a ranked "Top Picks" board.
Static site on GitHub Pages; data refreshed ~3×/day by GitHub Actions. No servers, no paid services.

**Live site:** https://aaugustin67-dotcom.github.io/propscout/

## Features
- **Top Picks (home)** — today's best props ranked by a transparent 0–100 score, with the reasons listed on each card.
- **Props board** — every passing / rushing / receiving / anytime-TD prop on this week's slate. Filter by market, position, game, team, side, hit-rate window & minimum, matchup (soft/neutral/tough D), injuries, book-lines-only. Sort by score, hit rate, cushion, matchup, kickoff.
- **Player page** — market tabs, editable line + alt-line buttons (everything recomputes), Over/Under toggle, bar chart of last 20 games vs line, hit rates L3/L5/L10/season/H2H/home/away, splits (season, home/away, favorite/underdog, vs tough/soft defenses, vs opponent), full game log, teammate-out filter, matchup panel with both teams' injury reports, sportsbook line comparison & line movement.
- **Defense vs Position** — yards/receptions/TDs allowed per game to QB/RB/WR/TE, ranked 1–32, heat-mapped, sortable.
- **Trending** — longest active streaks vs the line, usage trending up/down (last 3 vs season).
- **Watchlist** (★) and **Slip builder** (parlay odds from best prices, naive hit probability, copy to clipboard). Saved in your browser.
- **Injury report** and **Data status** pages.

## The score
`25% L10 hit rate + 20% L5 + 15% season + 10% head-to-head (season rate if <2 meetings) + 15% cushion (L10 avg vs line) + 15% matchup (opponent's defense-vs-position rank)`.
Players listed Out/Doubtful/IR, players who missed their team's last two games, and games already started are excluded.

## Data sources (all free)
| Data | Source | Key? |
|---|---|---|
| Weekly player stats 2024–current | [nflverse-data](https://github.com/nflverse/nflverse-data) `stats_player_week_<season>.csv` | No |
| Schedule, spreads/totals | [nflverse/nfldata games.csv](https://github.com/nflverse/nfldata) | No |
| Injuries | ESPN public injuries feed | No |
| Player prop lines (default) | [Bovada](https://www.bovada.lv/sports/football/nfl) public NFL prop feed — one JSON request per refresh, no key | No |
| Extra books' prop lines (DraftKings, FanDuel, BetMGM…) | [The Odds API](https://the-odds-api.com) free tier, 500 credits/month | Optional – `ODDS_API_KEY` |

Without the odds key the app still shows **real sportsbook lines**: every refresh scrapes Bovada's public NFL prop feed once (no signup, no credits, no rate-limit budget) for passing yards, passing TDs, completions, rushing yards, receiving yards, receptions and anytime TD, keeping each player's least-vig (main) line. Only when a slate has no props posted yet does it fall back to **model lines** (the .5 line closest to a 50/50 split of the last 10 games).

### Adding more books (optional – The Odds API key)
1. Sign up for the free Starter plan at https://the-odds-api.com/#get-access — the key is emailed to you.
2. In this repo: **Settings → Secrets and variables → Actions → New repository secret**, name `ODDS_API_KEY`, paste the key.
3. **Actions → Refresh data & deploy → Run workflow** (or wait for the next scheduled run).

Budget guard: each game's props (7 markets, ~7 credits) are fetched **once**, ~30 h before kickoff, and fetching stops if fewer than 30 credits remain — about 450 credits/month in season. Tunable via env vars `ODDS_WINDOW_HOURS`, `ODDS_FETCHES_PER_EVENT`, `ODDS_MIN_REMAINING` in the workflow (raise fetches per event only on a paid plan).

## Optional Discord alerts
Add a repo secret `DISCORD_WEBHOOK_URL` (Discord → channel settings → Integrations → Webhooks) to get a message whenever new sportsbook lines are loaded.

## Refresh schedule
`.github/workflows/refresh.yml` runs at 12:00, 18:00 and 23:00 UTC (≈7 AM, 1 PM, 6 PM Eastern), commits `docs/data/*.json`, and redeploys Pages. Run it any time from the Actions tab.

## Local development
```bash
python3 scripts/build_data.py          # writes docs/data/*.json (set ODDS_API_KEY to include lines)
cd docs && python3 -m http.server 8000 # open http://localhost:8000
```

_For personal research only. Not betting advice._
