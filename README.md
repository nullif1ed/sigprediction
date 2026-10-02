# PredictionCup Bot

Research, **paper-trading** and (opt-in) **live arbitrage trading** system for the Susquehanna Predictions Cup (Midterm Elections tournament, starting bankroll 100,000 SUSQies). It monitors every SIG market, compares prices with Polymarket and Kalshi, estimates fair value, ranks all four actions (BUY/SELL × YES/NO) by risk-adjusted net edge, sizes positions within risk limits and simulates execution against the real order books. Real orders are placed only when `LIVE_TRADING=1` (see *Live trading*).

Built from `PREDICTIONCUP_SPEC.md`; this is the pre-Day-1 deliverable.

## How SIG markets actually work (from the API reference)

- Every market is one binary exchange quoted in YES terms. The NO side is derived: **BUY NO = 1 − YES bid**, **SELL NO = 1 − YES ask**.
- A SELL you are not holding is "unbacked": SIG fills `sell yes q@p` as `buy no q@(1−p)` (and vice versa). The bot tracks all four actions separately but uses these economics, and ranks an unbacked SELL and its equivalent BUY as one trade.
- No fees in the contest, so net edge = fair value − VWAP (gross edge − half spread − slippage).
- Because NO is derived from YES, a single market can never show YES ask + NO ask < 1. Real arbitrage appears **across** mutually exclusive markets in one race: if the Democratic and Republican YES bids for a seat sum above 1, buying NO on both locks in a profit. The bot detects and paper-executes this (for example, the Delaware Senate pair on 30 Sep 2026: bids 0.95 + 0.08 = 1.03).
- **Rate limits:** 100 reads and 30 writes per minute per **account** (shared by every key, the dashboard and any Vercel UI); the collector uses 75% and cuts its budget by 20% after any 429, recovering slowly; a 429 response carries `Retry-After: 60`. The collector uses a sliding window capped at 85 reads per minute. Bulk `/exchanges/prices` covers all 237 markets in 3 reads every 6 s; in between, a 2 s fast loop polls only the *hot* markets (held positions, races showing an arbitrage spread at the top of book, markets with live signals) in a single read. The rest of the budget refreshes depth in parallel, hot and arbitrage legs first; depth reads fail fast (4 s, one retry) so a slow request can't stall the loop. Polling every 100ms is not possible within this budget. The fast path is SIG's Realtime WebSocket feed, which doesn't count against the limit (next step, below).

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
  exits       take-profit / fair-value exits on the VWAP of shares that clear the target (scale out),
              mid-based stop confirmed over 2 ticks and suspended while the book is dislocated,
              breakeven exit, limit-protected sales, arbitrage-set unwind
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

## Exit and arbitrage rules (tuned on the 1 Oct 2026 data)

- **Take profit**: sells only the shares that clear entry + 1pp (or 2% of entry, whichever is smaller), with that price as the limit. Before, the target was checked against the best bid but the whole position was market-sold through the book, so several "profit_target" exits realised losses.
- **Stops**: measured on the contract mid against the mid right after entry, must hold for 2 consecutive ticks, never sell more than 2pp below the touch, and are suspended while the exit price is more than 8pp below our fair value. Other bots regularly pull a whole side of the book for a minute or two (market 387 on 1 Oct: bids from 0.96 to 0.16 and back), and the old stop sold into that.
- **Breakeven exit**: once 1.5pp of real profit was executable, the position is sold at about entry instead of being allowed to turn into a loss.
- **Mean reversion**: once the mid has reached our fair value (the mispricing closed), the position is sold at entry − 0.5pp or better instead of waiting for a target; if fair value moves 1.5pp below the mid, it exits limit-protected.
- **Sniping**: every tick, any resting ask (YES or NO side) priced 3pp or more below our fair value (confidence >= 0.5) is bought up to the risk caps, with that price as the limit; the normal exits sell it back. 2pp looked better in-sample but lost out of sample.
- **Entries** need 1.5pp net edge (1pp lost money out of sample).
- **Re-entry**: no adding to a position that is under water, and a 30 minute cool-down after a stop.
- **Arbitrage**: shares bought as part of a set are locked: regular trades can't net against them and regular exits can't sell them. A held set is unwound early (all legs, limit-protected) once 60% of its locked profit can be sold back, which frees the capital for new sets. Sets are detected on the books net of our own fills, so the "depth gone before execution" skips no longer happen, and the arbitrage budget is up to 90% of equity (50% per race, 2% cash reserve).

## Live trading

- `LIVE_TRADING=1` + a read+trade key: the engine decides on its simulated execution client as in paper trading; every simulated fill is mirrored to SIG as a **limit** order at the worst price the simulation walked (arbitrage sets and unwinds as one atomic multi-leg request), remainders are cancelled, and positions/cash are reconciled from SIG after every batch and every 30 s.
- Order books come from SIG Realtime (all 237 markets, full versioned books, no read budget); REST only resyncs gaps. Dashboard pages read the collector's memory, so they use no SIG reads.
- Arbitrage only by default (`regularTrading: false`): directional trades and sniping lost money on the newest unseen data.
- Arbitrage exits: the whole set is sold as soon as it can be sold back for its cost + 20% of its locked profit (min 0.2pp per set), walking the book as deep as it stays profitable; unequal legs (partial fills) are completed if still profitable, otherwise trimmed.
- Safety: sells never exceed real holdings, one leg ≤ `LIVE_MAX_ORDER_NOTIONAL`, stale entries dropped, new entries halt at `LIVE_MAX_DRAWDOWN` below the starting account value. Stopping collection stops trading.

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
