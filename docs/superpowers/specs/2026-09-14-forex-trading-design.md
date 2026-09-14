# Forex Assisted Trading — Design Spec

Status: Approved (pre-implementation)
Date: 2026-09-14
Scope: Phase 4 of the forex project (data feed → dashboard UI → backtesting → **assisted trading**). Depends on phase 1 (OANDA credential/config pattern, `bridge/net.mjs`'s SSRF-guarded client) and phase 3 (the moving-average-crossover strategy's SMA math, candle fetching). This is the highest-stakes phase in the project — it can place real trades with real money — and the design below was produced through an explicit multi-angle adversarial review pass (financial-risk, OANDA-API-correctness, security, and architecture) before being written up, not just the usual single-pass brainstorm.

**Out of scope for this phase:** a Telegram remote-control bot (explicitly deferred to a later phase — see conversation history); per-trade voice confirmation (the user has chosen pre-approved autonomous execution within the limits below); short positions (the strategy is long-only, matching phase 3); take-profit/trailing-stop management (a stop-loss-only exit model, plus the strategy's own exit signal, for this phase).

## Goal

Let the phase 3 moving-average-crossover strategy place and close **real** OANDA orders autonomously, running as a background poller, across multiple configurable pairs — governed by mandatory risk limits that cannot be silently bypassed, with a voice-accessible kill-switch and full recoverability if the bridge crashes or restarts.

## Safety architecture

This section is the core of the spec. Everything else is built to serve these invariants.

### Two-plus-one activation gates

Real money can only move if all of the following are true simultaneously:

1. `JARVIS_TRADING_ENABLED=true` — the trading poller doesn't start at all without this.
2. `JARVIS_OANDA_ALLOW_LIVE=true` — from phase 1; without it, every OANDA call in the whole bridge (pricing, backtesting, and now trading) targets the practice account regardless of what trading-specific flags say.
3. `JARVIS_TRADING_ARM=true` — **new, and checked fresh at every process boot, not persisted across restarts.** A restart *always* comes up halted; this flag must be explicitly present in the environment at the moment the bridge starts for trading to resume. There is no in-process "resume" action — re-arming after any halt (manual, daily-loss, or a crash) requires stopping the process, deciding it's genuinely safe to continue, and starting it again with this flag set. This is a deliberate inversion of the "restart to resume" idea from the initial design pass — an unattended crash-and-auto-restart must never silently resume trading.

### Mandatory limits — no permissive defaults

The trading poller refuses to start if any of these env vars are missing (not defaulted to "off"/unlimited):

- `JARVIS_TRADING_PAIRS` — comma-separated instrument list (e.g. `EUR_USD,GBP_USD`)
- `JARVIS_TRADING_MAX_POSITION_UNITS` — hard cap on units for any single trade
- `JARVIS_TRADING_MAX_TOTAL_UNITS` — hard cap on **summed units across all currently-open positions**, checked before opening a new one — this is what stops correlated pairs (EUR/USD and GBP/USD often move together) from compounding into risk no single per-trade cap would catch
- `JARVIS_TRADING_MAX_DAILY_LOSS` — an account-currency amount (not a pair-specific price delta)
- `JARVIS_TRADING_ATR_STOP_MULTIPLIER` — e.g. `2` meaning "stop-loss at 2× the 14-period ATR from entry"
- `JARVIS_TRADING_POLL_INTERVAL_MS` — how often the loop sweeps all pairs

### Daily-loss halt reads OANDA's own numbers, never recomputes them

The halt check is `realizedPL + unrealizedPL <= -MAX_DAILY_LOSS`, read directly from OANDA's `GET /v3/accounts/{accountID}` response (`unrealizedPL` field, plus the day's realized P&L derived from OANDA's own transaction history) — **not** computed by summing local candle-delta arithmetic. Phase 3's `scaleTradesToNotional` produces P&L in the pair's *quote* currency (JPY for USD_JPY, USD for EUR_USD, etc.), which is a real, already-existing bug if compared directly against one account-currency threshold — trading must not inherit it. "Daily" is defined as OANDA's own trading-day boundary (17:00 America/New_York, which shifts with US DST), read from the account/transaction data's own timestamps rather than reimplemented as a UTC-midnight reset.

Hitting the halt: the poller stops evaluating for new entries immediately, logs loudly with the exact numbers that triggered it, and does **not** attempt to close existing positions (their stop-losses, which are real resting orders on OANDA's side, remain the protection). The halt persists until a fresh boot with `JARVIS_TRADING_ARM=true`.

### Voice kill-switch, isolated and logged

`trading_halt` is a real-time, always-available tool (bypasses `JARVIS_ALLOW_WRITES`, the same class of exemption as `jarvis_eyes`) — but it lives in its **own** MCP server, `jarvis_trading_control`, holding only this one tool, rather than being an ad-hoc per-tool exemption inside a server that might later grow a second, unsafe tool. Every halt (whatever triggered it — voice, the daily-loss check, or a startup failure) is logged with its trigger source. There is no `trading_resume` tool — resuming is boot-time only, per the arm flag above.

### No naked positions, and stops aren't treated as an absolute guarantee

Every order is placed with `stopLossOnFill` attached — there is no code path that can open a position without one. The stop distance is ATR-based (14-period Average True Range computed from daily high/low/close, sized as `ATR × JARVIS_TRADING_ATR_STOP_MULTIPLIER`), not a fixed pip count, so it scales with each pair's actual volatility rather than being simultaneously too tight for volatile pairs and too loose for calm ones. This is documented, not treated as a solved problem: a stop-loss is a resting order, and a fast gap (a weekend open, a surprise news release) can fill past it — the design does not claim a stop-loss caps the loss to an exact number, only that it is the best available bound OANDA's own order types provide.

### Race safety

- **Per-tick lock**, not per-pair: the whole sweep across all configured pairs is one atomic unit from the poller's perspective — a second tick is skipped entirely if the previous sweep hasn't finished, the same in-flight-guard philosophy as phase 1's price poller, but scoped to the whole multi-pair sweep rather than one fetch.
- **State isn't trusted from memory between ticks.** Before evaluating whether to open a new position for a pair, the bridge queries OANDA's actual currently-open positions fresh (`GET /v3/accounts/{accountID}/openPositions`) — not an in-memory record — so a bridge restart mid-position, or a trade placed manually outside JARVIS, can't cause a double-entry. This query only happens when the incremental signal check (see below) indicates a candidate crossover on the latest candle, to avoid an API call on every pair on every tick when nothing changed.
- **Idempotent order IDs.** Every order carries a deterministic `clientExtensions.id` (derived from pair + signal date, so the same signal can never produce two accepted orders even if a check-then-act race slips through) — OANDA itself rejects a duplicate client ID, which is the actual backstop, not just the in-process lock.

### Order fill confirmation

A 200/201 HTTP response from `POST /v3/accounts/{accountID}/orders` does **not** mean the order filled — the response body's transaction carries the real outcome (`orderFillTransaction` = filled, `orderCancelTransaction`/`orderRejectTransaction` = it didn't). The order-placement code parses this and only records a position as opened on an actual `orderFillTransaction`; a rejected/unfilled order is logged and the next poll tick re-evaluates from OANDA's real state (which will correctly show no position), rather than the bot believing it holds something it doesn't.

### Recoverability

- **A crash or restart never loses stop-loss protection**, because the stop-loss is a real order sitting on OANDA's own books, not something the bot process has to keep enforcing while it's down.
- **On every boot** (whether or not `JARVIS_TRADING_ARM` is set), the bridge queries OANDA's actual open positions and reconciles: any position found that the bridge didn't expect is adopted in monitor-only mode (its exit signal is still tracked, but it is never re-entered if closed) — and if an open position is found **without** a stop-loss attached (e.g. a manual trade, or a prior stop-loss rejection that went unnoticed), that is logged as a loud warning requiring manual attention, not silently left unprotected.
- **A durable trade journal is the system of record**, not the WebSocket. Every order attempt (filled, rejected, or errored) is appended to a local append-only log (`bridge/data/trading-journal.jsonl` or similar — one JSON line per event, timestamp/pair/side/units/result) before anything is announced. The proactive spoken announcement (see below) is a convenience layered on top; if the browser tab is closed when a trade fires, the journal still has it, and a `trading_status` tool can read it back on request.

## Live signal detection (not the backtest replay function)

Phase 3's `movingAverageCrossoverStrategy` replays a full candle array from scratch and tracks its own internal notion of "am I in a position" — that internal notion can silently diverge from OANDA's real state (a rejected order, a manual trade, a restart). Reusing it directly for live decisions was identified as a structural mismatch during review.

Instead, `bridge/trading-signal.mjs` exports a dedicated function:

```
detectLiveSignal(candles, currentPosition, { fastPeriod, slowPeriod }) -> 'enter' | 'exit' | 'none'
```

It computes only the fast/slow SMA pair for the most recent two candles (sharing the `sma()` helper with `backtest.mjs`, not the trade-replay loop), and compares the crossover against `currentPosition` — a value that always comes from the live OANDA query described above, never from memory. This keeps the "what does the data say" logic (shared, tested) separate from "what do I already hold" (always fetched fresh), so the two can never drift into disagreeing with each other silently.

## Order placement details

- **Entry:** `POST /v3/accounts/{accountID}/orders`, body `{ order: { type: 'MARKET', instrument, units, timeInForce: 'FOK', positionFill: 'DEFAULT', stopLossOnFill: { price }, clientExtensions: { id } } }`. `units` is a positive integer (long-only, matching the strategy), capped by both `JARVIS_TRADING_MAX_POSITION_UNITS` and whatever headroom remains under `JARVIS_TRADING_MAX_TOTAL_UNITS`. `stopLossOnFill.price` is formatted to the correct decimal precision for the instrument (JPY pairs: 2-3 decimals; most others: 4-5 — read from OANDA's `/v3/accounts/{accountID}/instruments` `displayPrecision`, not hard-coded per pair).
- **FOK is used deliberately for entries**: if liquidity is too thin to fill immediately, the order is cancelled rather than partially filled at a worse-than-expected price — and because the design always re-derives state from OANDA rather than assuming success, a cancelled entry just means the next tick re-evaluates the same signal, which is the correct, self-healing behavior for an unattended bot.
- **Exit:** `PUT /v3/accounts/{accountID}/positions/{instrument}/close`, body `{ longUnits: 'ALL' }` — correct for a long-only strategy; if an unexpected short position is ever found during the boot-time reconciliation (see Recoverability), it is flagged rather than silently ignored by this long-only close call.
- **Market-closed check:** before attempting any entry, the pair's `tradeable` status (already available from phase 1's price cache) is checked — no order is attempted against a closed market.

## Proactive announcements

A new WebSocket message type, pushed by the bridge outside the normal Claude-turn request/response flow, that the frontend speaks directly and appends to the transcript — the first time this codebase needs a push that isn't a reply to something the user said. The announcement text is built from a **fixed template with only numeric/enum interpolation** (pair name from the configured list, side, units, price — never free text), so there is no path for arbitrary text to reach the speech synthesizer through this channel. As covered under Recoverability, this is a convenience layer: the trade journal is the actual record, so a missed announcement (tab closed) is not a lost trade record.

## MCP tools

- `jarvis_trading_control` (its own server, isolated per the security review): `trading_halt` — stops the loop, logs the trigger source, always allowed.
- `jarvis_trading` (regular server, gated the same way as `jarvis_forex`/`jarvis_backtest` — read-only, always allowed): `trading_status` — reports current state: armed/halted, open positions, today's realized+unrealized P&L against the daily cap, last few journal entries.

## Error handling

- Missing/invalid OANDA credentials or any missing mandatory risk-limit env var: the trading poller does not start; the bridge logs why and continues running everything else (forex feed, backtesting, voice) normally — a misconfigured trading phase must never take down the rest of JARVIS.
- Any order whose `stopLossOnFill` leg does not confirm attached (parsed from the fill transaction) is treated as an immediate close-and-halt — an unprotected live position is never left open by design.
- Repeated OANDA errors (network, 5xx) during a sweep: logged, the tick ends without placing anything, the next tick tries again — no retry storm, matching phase 1's backoff philosophy.

## Testing

- Pure functions — `detectLiveSignal`, ATR calculation, the risk-limit checks (per-trade cap, total-exposure cap, daily-loss comparison), OANDA order-response parsing (fill vs. reject vs. cancel from fixture transaction JSON), per-instrument stop price formatting — all unit-tested with `node --test`, following the same fixture-based approach as phases 1 and 3.
- Order placement/closing calls themselves are not unit-tested (real network calls, same reasoning as `fetchPricingOnce`/`fetchCandlesOnce`) — verified manually against the OANDA **practice** account only. Live-account verification is explicitly out of scope for automated testing in this repo and is the user's own responsibility before ever setting `JARVIS_TRADING_ARM=true` against a real account.
- The boot-time reconciliation logic (adopt unexpected positions, flag missing stop-losses) is unit-tested against fixture "OANDA open positions" responses covering: no positions, an expected position, an unexpected position, a position missing a stop-loss.
