# PredictionCup Bot

Research and **paper-trading** system for the Susquehanna Predictions Cup (Midterm Elections tournament, starting bankroll 100,000 SUSQies). It monitors every SIG market, compares prices with Polymarket and Kalshi, estimates fair value, ranks all four actions (BUY/SELL × YES/NO) by risk-adjusted net edge, sizes positions within risk limits and simulates execution against the real order books. **No code path places orders on SIG.**

Built from `PREDICTIONCUP_SPEC.md`; this is the pre-Day-1 deliverable.

## How SIG markets actually work (from the API reference)

- Every market is one binary exchange quoted in YES terms. The NO side is derived: **BUY NO = 1 − YES bid**, **SELL NO = 1 − YES ask**.
- A SELL you are not holding is "unbacked": SIG fills `sell yes q@p` as `buy no q@(1−p)` (and vice versa). The bot tracks all four actions separately but uses these economics, and ranks an unbacked SELL and its equivalent BUY as one trade.
- No fees in the contest, so net edge = fair value − VWAP (gross edge − half spread − slippage).
- Because NO is derived from YES, a single market can never show YES ask + NO ask < 1. Real arbitrage appears **across** mutually exclusive markets in one race: if the Democratic and Republican YES bids for a seat sum above 1, buying NO on both locks in a profit. The bot detects and paper-executes this (for example, the Delaware Senate pair on 30 Sep 2026: bids 0.95 + 0.08 = 1.03).
- **Rate limits:** 100 reads and 30 writes per minute per key; a 429 response carries `Retry-After: 60`. The collector uses a sliding window capped at 85 reads per minute. Bulk `/exchanges/prices` covers all 237 markets in 3 reads; the rest of the budget refreshes order-book depth, with changed books first. Polling every 100ms is not possible within this budget. The fast path is SIG's Realtime WebSocket feed, which doesn't count against the limit (next step, below).

## Architecture

```
lib/core      pure, unit-tested logic (no I/O)
  orderbook   normalized YES book, 4-action levels, VWAP, slippage, imbalance
  races       title parsing, race grouping, Polymarket/Kalshi identifiers (cycle-pinned)
  news        headline sentiment, source credibility, time-decayed impact
  fairValue   blend of SIG mid, external venues, complement market, news, imbalance
              -> fair probability + separate confidence + bounds
  opportunity all four actions, net edge, risk-adjusted score, ranking
  arbitrage   cross-market sets and crossed books
  sizing      fixed fractional, volatility-adjusted, fractional Kelly, hard limits, scenarios
  exits       profit target, move-based stop, fair value reached, near resolution, headline decay
  portfolio   cash, FIFO lots, YES/NO netting, unbacked-sell canonicalization, P&L, drawdown
  execution   ExecutionClient interface + PaperExecutionClient (market/limit, partial fills,
              cancel/replace/expiry, consumed liquidity)
  engine      one strategy tick: exits -> arbitrage -> headline -> regular opportunities
lib/server    I/O
  sigClient   read-only SIG client: auth, retries, 429 back-off, timeouts, pagination
  external    Polymarket Gamma + Kalshi (batched) matching and discrepancy stats
  collector   start/stop data collection + optional live paper trading
  backtest    event-driven replay of collected data (no look-ahead, latency, 4 portfolios)
  db/store    SQLite via node:sqlite (schema in db.ts)
app/          Next.js UI + API routes
```

### Pages
- **Dashboard**: start/stop data collection, read budget, paper portfolio, top opportunities, news.
- **Markets / market detail**: all four action prices, YES/NO order book, ticket with VWAP and the unbacked-sell explanation, fair-value breakdown, external quotes, related news.
- **Opportunities**: ranked live scan with reasons, plus the arbitrage monitor.
- **Cross-venue**: SIG vs Polymarket/Kalshi gaps, executable gaps, liquidity-adjusted difference, z-scores once history exists.
- **Paper portfolio / Trade log**: positions, every simulated order, fills, decisions (including risk rejections), CSV export.
- **Backtest**: start/stop a replay; live equity curves for all sizing portfolios; trade feed; logs with level filter; history of every strategy variant; compare two runs; clone & modify; CSV export.

## Backtesting and auto-sizing

Every signal is sized by **all three strategies in parallel portfolios**, plus an `auto` portfolio. P&L is attributed to the entry scenario (edge × confidence × liquidity × time-to-resolution buckets, plus `headline` and `arbitrage`), and the strategy with the best return on deployed capital becomes that scenario's rule. A completed run saves these rules. `auto` sizing and live paper trading then use them, falling back to defaults until a scenario has at least 5 trades.

## Run locally (Day 1)

Requires Node 22.13 or newer (it uses the built-in `node:sqlite`).

```bash
npm install
cp .env.example .env.local      # set SIG_API_KEY
npm run build && npm start      # http://localhost:3000
```

Then on the dashboard click **Start collecting data** (with "paper-trade live" ticked). Leave the laptop running, and start backtests from the Backtest page whenever enough data has accumulated. Collection resumes automatically after a server restart.

```bash
npm test          # vitest: unit + mock-API integration tests
npm run lint
npm run typecheck
```

## Deploy

- **Vercel (UI + live views):** set `SIG_API_KEY`. Markets, cross-venue, opportunities and market detail work serverlessly, and their responses are cached so page views cannot exhaust the read budget. Collection, paper trading and backtests need a long-running process with a disk. On Vercel those endpoints return a clear 503, or proxy to `BOT_BACKEND_URL` once it's set.
- **Day 2 backend:** run the same app on a VPS or container (`npm run build && npm start`, with a persistent `DB_PATH` volume). Set `BOT_ADMIN_TOKEN` on that host, then set `BOT_BACKEND_URL` on Vercel.

## Known limitations / next steps

- Realtime WebSocket feed (`POST /realtime/token`, `tournament:{id}:market:{id}` channels): pushes full books without using the read budget, which is the route to sub-second headline reaction.
- The news feed comes from SIG's public site endpoint (`/api/markets/{id}/news`). It isn't part of the documented v1 API, so it could change. Headlines have day-level publish dates, so headline "freshness" is measured from when the collector first saw them. Headlines already present on a market's first fetch are back-dated so they aren't traded.
- A few races have no equivalent external market (for example, Alaska races with candidate-only markets).
- The weekly retraining and live (trade-scope) execution client from the spec aren't built yet, by design for this phase.
