# Forex Backtesting — Design Spec

Status: Approved (pre-implementation)
Date: 2026-09-14
Scope: Phase 3 of the forex project (data feed → dashboard UI → **backtesting** → assisted trading). Depends on phase 1's OANDA credential/config pattern (`JARVIS_OANDA_*` env vars, `bridge/net.mjs`'s SSRF-guarded client), but not on phase 1's live-price poller or phase 2's ticker — this is a separate data path (historical candles, not live pricing).

## Goal

Let a strategy be tested against a year of historical daily OANDA data, producing summary performance stats and a trade list — triggerable both by voice ("backtest a moving-average strategy on EUR/USD") and from the command line, sharing one engine so there is exactly one implementation of the strategy/stats logic.

## Out of scope (this phase)

- Live/assisted trading (phase 4)
- Charts/equity curves (the blade sanitiser has no canvas/SVG support; results are shown as text stats + a trade table, not a line chart — see "Detail display" below)
- Strategy optimization, parameter sweeps, multiple strategies (only one example strategy, moving-average crossover, ships this phase)
- Persisting results to disk (ephemeral — a backtest run's results live only in that conversation turn / CLI output)

## Architecture

**New module `bridge/backtest.mjs`**, structured the same way as `bridge/forex.mjs` (phase 1): pure, testable functions plus a thin MCP-tool wrapper.

- **Candle fetching:** `fetchCandlesOnce({ host, accountId, apiKey, pair, granularity, count })` — one HTTP request to OANDA's candles endpoint, routed through `net.mjs`'s `vetTarget`/`openRemote` (the same SSRF-guarded client `forex.mjs` uses), reusing the same `JARVIS_OANDA_*` env vars and `resolveEnv()`/`hostFor()` helpers already exported from `forex.mjs` (imported, not duplicated).
- **Strategy:** `movingAverageCrossoverStrategy(candles, { fastPeriod, slowPeriod }) => Trade[]` — a pure function. Long-only, one position at a time: buy when the fast MA crosses above the slow MA, close when it crosses back below. Written as a plain function taking candles in and trades out, specifically so a second strategy can be added later as a sibling function without changing the engine around it.
- **Stats:** `computeStats(trades, startingBalance) => Stats` — a pure function computing total return %, win rate, max drawdown %, trade count, from a trade list. Also pure and independently testable.
- **MCP tool:** `backtest_run(pair, fastPeriod?, slowPeriod?, count?)` — orchestrates: fetch candles → run strategy → compute stats → return **plain text** (numbers and a compact trade list), not pre-built HTML. This matches the existing pattern confirmed in `bridge/panels.mjs`: JARVIS composes `hud-*` markup himself from tool output via the `display` tool; no bridge-side HTML-building code is introduced, keeping exactly one "tool returns data, JARVIS renders it" pattern in the codebase rather than a second one.
- **New `scripts/backtest.mjs`**: a CLI wrapper importing `fetchCandlesOnce`, `movingAverageCrossoverStrategy`, and `computeStats` directly from `bridge/backtest.mjs`, printing results to the console. Exists so a backtest can be run and iterated on without going through voice/JARVIS at all.

## Data fetching

`GET /v3/instruments/{instrument}/candles?granularity=D&count=252&price=M` against the same OANDA host/credentials as phase 1 (`api-fxpractice.oanda.com` or `api-fxtrade.oanda.com` depending on `JARVIS_OANDA_ENV`). `D` = daily candles, `252` ≈ one trading year (the default lookback), `M` = midpoint price (open/high/low/close derived from mid, not bid/ask — appropriate for backtesting, where bid/ask spread isn't being modeled this phase).

**Open item to verify during implementation, not assumed here** (same caution as phase 1's pricing endpoint verification): the exact candles endpoint path, whether `count` has a hard maximum on OANDA's side (commonly reported as 5000, but confirm against current docs), and the exact response field names for OHLC values (expected shape, per partial doc access: `{ candles: [{ time, mid: { o, h, l, c }, volume, complete }] }` — confirm `mid` vs a differently-named key before coding the parser).

## Strategy: moving-average crossover

- **Parameters:** `fastPeriod` (default 10), `slowPeriod` (default 30), both in candle counts (days, given daily candles).
- **Signal:** buy (open a long position) when the fast simple moving average crosses from below to above the slow simple moving average; close the position when it crosses back below. Only one position open at a time — a buy signal while already in a position is ignored, as is a close signal while flat.
- **Position sizing:** fixed notional per trade (not compounding), so each trade's P&L is independently comparable — kept simple since this phase is about proving the engine works, not modeling realistic capital allocation.
- **Output:** a `Trade[]` — each trade has entry date/price, exit date/price, and P&L (computed by the strategy function itself, since it already knows both prices).

## Stats

Computed by `computeStats(trades, startingBalance)`:
- **Total return %** — (ending balance − starting balance) / starting balance, where balance evolves trade-by-trade from the fixed-notional P&L values.
- **Win rate** — % of trades with positive P&L.
- **Max drawdown %** — largest peak-to-trough decline in the running balance across the trade sequence.
- **Trade count.**

## Detail display

`backtest_run` returns a text summary (the four stats above) plus a compact per-trade list (date in, date out, P&L) as plain text in the tool result. JARVIS's existing system prompt already instructs him to put substantial results on a blade via `display`, using the `.hud-rows`/`.hud-row`/`.hud-metric` etc. vocabulary — no new blade-building code is needed on the bridge side for this. This deliberately does not attempt an equity-curve chart (out of scope — see above).

## Error handling

- **Missing/invalid OANDA credentials:** same behavior as phase 1 — the tool returns a clear "forex backtesting isn't configured" message rather than a raw error.
- **No candles returned** (bad instrument name, insufficient history for the requested `count`): a plain "no historical data available for X" message, not a stack trace.
- **Zero trades generated** (e.g. no crossovers occurred in the window): reported as a valid, if unexciting, result — "0 trades, no crossovers occurred in this window" — not treated as an error.

## Testing

- `movingAverageCrossoverStrategy` — unit-tested against fixture candle series with known, hand-constructed crossover points, asserting the exact expected trades (entry/exit dates and prices).
- `computeStats` — unit-tested against a fixed trade list with known expected total return, win rate, and max drawdown.
- `fetchCandlesOnce` — not unit-tested (same reasoning as phase 1's `fetchPricingOnce`: it's a real network call). Verified manually via the CLI script and/or the MCP tool once OANDA credentials are available.
- All tests run via the existing `node --test bridge/**/*.test.mjs` pattern from phase 1 — no new test infrastructure needed.
