# Forex Assisted Trading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the phase 3 strategy place and close real OANDA orders autonomously via a background poller, governed by mandatory risk limits, a voice kill-switch, and full recoverability across restarts.

**Architecture:** Four new bridge modules, split by concern per the design review: `trading-signal.mjs` (live crossover detection, sharing SMA math with `backtest.mjs`), `trading-risk.mjs` (ATR, position/exposure/daily-loss limit checks), `trading-orders.mjs` (OANDA order placement/closing, fill-confirmation parsing, price formatting), and `trading.mjs` (the poller, the trade journal, boot reconciliation, and the two MCP servers). A new WebSocket push message type carries proactive trade announcements from bridge to frontend.

**Tech Stack:** Node.js (ESM), `zod` + `@anthropic-ai/claude-agent-sdk`, `node:test`, matching phases 1-3 exactly. Frontend: the existing `bridge.ts` out-of-band push pattern (`watchPanels`/`watchBlades`/`watchUi`) extended with `watchAnnounce`.

**Depends on:** Phase 1 (`resolveEnv`/`hostFor`, `JARVIS_OANDA_ALLOW_LIVE`, `net.mjs`'s SSRF-guarded client), Phase 3 (`fetchCandlesOnce`, the `sma()` helper — exported from `backtest.mjs` in Task 1 below, currently private).

**Spec:** `C:\Users\irons\jarvis\docs\superpowers\specs\2026-09-14-forex-trading-design.md` — **read this in full before starting**. It carries the safety reasoning behind every mandatory check in this plan; the plan implements it but doesn't re-explain why.

**⚠️ This phase places real trades with real money once `JARVIS_TRADING_ARM=true` is set against a live OANDA account. Every task below defaults to the practice account and to a halted state. Manual verification (Task 12) must be done against the OANDA practice account only — never verify this feature against a live account.**

---

## File Structure

- **Modify:** `bridge/backtest.mjs` — export the existing private `sma()` helper.
- **Create:** `bridge/trading-signal.mjs` + test — live signal detection.
- **Create:** `bridge/trading-risk.mjs` + test — ATR, true range, position/exposure/daily-loss limit checks.
- **Create:** `bridge/trading-orders.mjs` + test — order-response parsing, price formatting, client order IDs (pure); order placement/closing/position-query network calls (not unit-tested, same reasoning as `fetchPricingOnce`).
- **Create:** `bridge/trading.mjs` + test — the trade journal, boot reconciliation, the poller, and both MCP servers (`jarvis_trading`, `jarvis_trading_control`).
- **Modify:** `bridge/server.mjs` — wire in both new MCP servers, `decideTool` rules, boot-time trading init call.
- **Modify:** `src/lib/bridge.ts` — `watchAnnounce` out-of-band push handler.
- **Modify:** `src/App.tsx` — speak + transcript an incoming announcement.
- **Modify:** `README.md` — document every new env var and the manual practice-account verification steps.

---

### Task 1: Export `sma`, then live signal detection

**Files:**
- Modify: `bridge/backtest.mjs`
- Create: `bridge/trading-signal.mjs`
- Test: `bridge/trading-signal.test.mjs`

- [ ] **Step 1: Export the existing `sma` helper**

In `bridge/backtest.mjs`, change:

```js
function sma(values, period, index) {
```

to:

```js
export function sma(values, period, index) {
```

No other change to that file. Run `node --test bridge/backtest.test.mjs` to confirm all existing tests still pass (this is a pure signature-visibility change, must be a no-op for behavior).

- [ ] **Step 2: Write the failing tests**

Create `bridge/trading-signal.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectLiveSignal } from './trading-signal.mjs'

function candlesFromCloses(closes) {
  return closes.map((close, i) => ({
    time: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
    open: close, high: close, low: close, close,
  }))
}

test('detectLiveSignal returns "enter" on a fresh crossover with no current position', () => {
  // Same fixture shape as backtest.test.mjs's known-crossover series: the
  // crossover happens at index 3 (close 12).
  const candles = candlesFromCloses([10, 10, 10, 12, 14, 16])
  const signal = detectLiveSignal(candles.slice(0, 4), null, { fastPeriod: 2, slowPeriod: 3 })
  assert.equal(signal, 'enter')
})

test('detectLiveSignal returns "none" for the same crossover if a position is already open', () => {
  const candles = candlesFromCloses([10, 10, 10, 12, 14, 16])
  const signal = detectLiveSignal(candles.slice(0, 4), { entryPrice: 11 }, { fastPeriod: 2, slowPeriod: 3 })
  assert.equal(signal, 'none')
})

test('detectLiveSignal returns "exit" on a downward crossover with a position open', () => {
  // Rises then falls back through the slow MA — using the same closes as
  // backtest.test.mjs's "one trade" fixture, evaluated up through the exit
  // candle (index 6).
  const candles = candlesFromCloses([10, 10, 10, 12, 14, 16, 10])
  const signal = detectLiveSignal(candles, { entryPrice: 12 }, { fastPeriod: 2, slowPeriod: 3 })
  assert.equal(signal, 'exit')
})

test('detectLiveSignal returns "none" when there is not enough history for the slow period', () => {
  const candles = candlesFromCloses([10, 10])
  const signal = detectLiveSignal(candles, null, { fastPeriod: 2, slowPeriod: 3 })
  assert.equal(signal, 'none')
})

test('detectLiveSignal returns "none" mid-trend with no fresh crossover', () => {
  const candles = candlesFromCloses([10, 10, 10, 12, 14])
  const signal = detectLiveSignal(candles, { entryPrice: 12 }, { fastPeriod: 2, slowPeriod: 3 })
  assert.equal(signal, 'none')
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test bridge/trading-signal.test.mjs`
Expected: FAIL — `bridge/trading-signal.mjs` does not exist yet.

- [ ] **Step 4: Write the implementation**

Create `bridge/trading-signal.mjs`:

```js
/**
 * Live, incremental signal detection for the moving-average-crossover
 * strategy — deliberately NOT the same function as
 * backtest.mjs's movingAverageCrossoverStrategy, which replays a full
 * candle array from scratch and tracks its own internal notion of "am I in
 * a position". That internal notion can silently diverge from what OANDA
 * actually reports (a rejected order, a manual trade, a restart), which is
 * unacceptable for live trading. This function only ever answers "given
 * the most recent two candles and the position the caller says is
 * currently open (which must always come from a fresh OANDA query, never
 * from memory), what should happen now" — sharing only the SMA math with
 * the backtest engine, not its trade-replay loop.
 */

import { sma } from './backtest.mjs'

/**
 * @param {Array<{close:number}>} candles - ascending by time, most recent last
 * @param {object|null} currentPosition - truthy if a position is currently
 *   open for this pair (per a fresh OANDA query), null/undefined if flat
 * @param {{fastPeriod:number, slowPeriod:number}} params
 * @returns {'enter'|'exit'|'none'}
 */
export function detectLiveSignal(candles, currentPosition, { fastPeriod, slowPeriod }) {
  const n = candles.length
  if (n < slowPeriod + 1) return 'none'

  const closes = candles.map((c) => c.close)
  const fastNow = sma(closes, fastPeriod, n - 1)
  const slowNow = sma(closes, slowPeriod, n - 1)
  const fastPrev = sma(closes, fastPeriod, n - 2)
  const slowPrev = sma(closes, slowPeriod, n - 2)

  if (fastNow === null || slowNow === null || fastPrev === null || slowPrev === null) {
    return 'none'
  }

  const crossedUp = fastPrev <= slowPrev && fastNow > slowNow
  const crossedDown = fastPrev >= slowPrev && fastNow < slowNow

  if (crossedUp && !currentPosition) return 'enter'
  if (crossedDown && currentPosition) return 'exit'
  return 'none'
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test bridge/trading-signal.test.mjs`
Expected: PASS, all 5 tests green.

- [ ] **Step 6: Commit**

```bash
git add bridge/backtest.mjs bridge/trading-signal.mjs bridge/trading-signal.test.mjs
git commit -m "trading: export sma() and add live incremental signal detection"
```

---

### Task 2: ATR and true range

**Files:**
- Create: `bridge/trading-risk.mjs`
- Test: `bridge/trading-risk.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `bridge/trading-risk.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { trueRange, computeATR } from './trading-risk.mjs'

test('trueRange for the first candle is just its own high-low range', () => {
  const candles = [{ high: 1.12, low: 1.10, close: 1.11 }]
  assert.ok(Math.abs(trueRange(candles, 0) - 0.02) < 1e-9)
})

test('trueRange picks the largest of the three OANDA-standard components', () => {
  const candles = [
    { high: 1.10, low: 1.08, close: 1.09 },
    { high: 1.095, low: 1.085, close: 1.09 }, // gap up from prev close 1.09: |1.095-1.09|=0.005, range 0.01
  ]
  // range = 0.01, |high-prevClose| = 0.005, |low-prevClose| = 0.005 -> max is range 0.01
  assert.ok(Math.abs(trueRange(candles, 1) - 0.01) < 1e-9)
})

test('trueRange uses the gap when it exceeds the candle range', () => {
  const candles = [
    { high: 1.10, low: 1.08, close: 1.09 },
    { high: 1.30, low: 1.28, close: 1.29 }, // big gap up overnight
  ]
  // range = 0.02, |high-prevClose| = |1.30-1.09| = 0.21 -> that wins
  assert.ok(Math.abs(trueRange(candles, 1) - 0.21) < 1e-9)
})

test('computeATR averages true range over the requested period', () => {
  // Five flat candles, high-low always 0.01, no gaps -> ATR(3) should be 0.01.
  const candles = Array.from({ length: 5 }, () => ({ high: 1.11, low: 1.10, close: 1.105 }))
  const atr = computeATR(candles, 3)
  assert.ok(Math.abs(atr - 0.01) < 1e-9)
})

test('computeATR returns null when there is not enough history', () => {
  const candles = Array.from({ length: 2 }, () => ({ high: 1.11, low: 1.10, close: 1.105 }))
  assert.equal(computeATR(candles, 14), null)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test bridge/trading-risk.test.mjs`
Expected: FAIL — `bridge/trading-risk.mjs` does not exist yet.

- [ ] **Step 3: Write the implementation**

Create `bridge/trading-risk.mjs`:

```js
/**
 * Risk limits for live trading: volatility-aware stop sizing (ATR) and the
 * mandatory position/exposure/daily-loss checks. All pure functions,
 * operating on values the caller fetched fresh from OANDA — this module
 * never calls OANDA itself.
 */

/**
 * OANDA-standard True Range: the largest of the candle's own high-low
 * range, the gap up from the previous close, and the gap down from it. The
 * first candle in a series has no previous close, so its true range is
 * just its own range.
 */
export function trueRange(candles, i) {
  const c = candles[i]
  if (i === 0) return c.high - c.low
  const prevClose = candles[i - 1].close
  return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose))
}

/**
 * Simple (not Wilder-smoothed) average true range over the last `period`
 * candles. A plain average is chosen over Wilder's smoothing for this
 * phase — it is simpler to reason about and test, and is a defensible
 * first cut; revisit only if live use shows it under/over-reacts.
 */
export function computeATR(candles, period = 14) {
  if (candles.length < period) return null
  let sum = 0
  for (let i = candles.length - period; i < candles.length; i++) {
    sum += trueRange(candles, i)
  }
  return sum / period
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test bridge/trading-risk.test.mjs`
Expected: PASS, all 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add bridge/trading-risk.mjs bridge/trading-risk.test.mjs
git commit -m "trading: add true-range and ATR calculation"
```

---

### Task 3: Risk limit checks (position size, exposure, daily-loss halt)

**Files:**
- Modify: `bridge/trading-risk.mjs`
- Modify: `bridge/trading-risk.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `bridge/trading-risk.test.mjs`:

```js
import { computeStopLossPrice, checkPositionSize, checkTotalExposure, checkDailyLossHalt } from './trading-risk.mjs'

test('computeStopLossPrice places the stop below entry for a long, by ATR times the multiplier', () => {
  const price = computeStopLossPrice(1.1000, 0.0020, 2)
  assert.ok(Math.abs(price - 1.0960) < 1e-9) // 1.1000 - (0.0020 * 2)
})

test('checkPositionSize allows units at or under the cap, rejects over', () => {
  assert.equal(checkPositionSize(1000, 1000), true)
  assert.equal(checkPositionSize(1001, 1000), false)
})

test('checkTotalExposure allows a new trade that keeps total exposure at or under the cap', () => {
  assert.equal(checkTotalExposure(4000, 1000, 5000), true) // 4000+1000=5000, at cap
  assert.equal(checkTotalExposure(4500, 1000, 5000), false) // 5500 > 5000
})

test('checkDailyLossHalt triggers once realized+unrealized P&L breaches the negative cap', () => {
  // 5000 loss cap, -4999 combined -> not yet halted
  assert.equal(checkDailyLossHalt(-3000, -1999, 5000), false)
  // -5000 combined -> halted (at the boundary)
  assert.equal(checkDailyLossHalt(-3000, -2000, 5000), true)
  // profit -> never halted regardless of magnitude
  assert.equal(checkDailyLossHalt(10000, 0, 5000), false)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test bridge/trading-risk.test.mjs`
Expected: FAIL — the four new functions aren't exported yet.

- [ ] **Step 3: Write the implementation**

Append to `bridge/trading-risk.mjs`:

```js
/** Long-only: the stop always sits below entry, by ATR × multiplier. */
export function computeStopLossPrice(entryPrice, atr, multiplier) {
  return entryPrice - atr * multiplier
}

/** Per-trade cap — JARVIS_TRADING_MAX_POSITION_UNITS. */
export function checkPositionSize(units, maxPositionUnits) {
  return units <= maxPositionUnits
}

/**
 * Account-wide cap — JARVIS_TRADING_MAX_TOTAL_UNITS. Correlated pairs
 * (EUR_USD and GBP_USD often move together) mean a per-trade cap alone
 * doesn't bound total risk; this checks the SUM across every currently
 * open position plus the candidate new one.
 */
export function checkTotalExposure(currentTotalUnits, newUnits, maxTotalUnits) {
  return currentTotalUnits + newUnits <= maxTotalUnits
}

/**
 * Both realized and unrealized P&L must be supplied by the caller, read
 * directly from OANDA's own account endpoint — never recomputed locally.
 * A pair-scale price delta fed in here instead of a real account-currency
 * P&L would silently compare the wrong units, which is exactly the bug
 * this function exists to guard against by taking pre-converted numbers.
 */
export function checkDailyLossHalt(realizedPL, unrealizedPL, maxDailyLoss) {
  return realizedPL + unrealizedPL <= -Math.abs(maxDailyLoss)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test bridge/trading-risk.test.mjs`
Expected: PASS, all tests in the file green.

- [ ] **Step 5: Commit**

```bash
git add bridge/trading-risk.mjs bridge/trading-risk.test.mjs
git commit -m "trading: add position-size, exposure, and daily-loss-halt checks"
```

---

### Task 4: Order-response parsing, price formatting, client order IDs

**Files:**
- Create: `bridge/trading-orders.mjs`
- Test: `bridge/trading-orders.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `bridge/trading-orders.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseOrderResponse, formatStopPrice, buildClientOrderId } from './trading-orders.mjs'

test('parseOrderResponse reports a fill from orderFillTransaction', () => {
  const json = {
    orderFillTransaction: {
      price: '1.10015',
      tradeOpened: { tradeID: '123' },
    },
  }
  const result = parseOrderResponse(json)
  assert.equal(result.filled, true)
  assert.ok(Math.abs(result.fillPrice - 1.10015) < 1e-9)
  assert.equal(result.tradeId, '123')
})

test('parseOrderResponse reports a non-fill from orderCancelTransaction', () => {
  const json = { orderCancelTransaction: { reason: 'TIME_IN_FORCE_EXPIRED' } }
  const result = parseOrderResponse(json)
  assert.equal(result.filled, false)
  assert.equal(result.reason, 'TIME_IN_FORCE_EXPIRED')
})

test('parseOrderResponse reports a non-fill from orderRejectTransaction', () => {
  const json = { orderRejectTransaction: { rejectReason: 'INSUFFICIENT_MARGIN' } }
  const result = parseOrderResponse(json)
  assert.equal(result.filled, false)
  assert.equal(result.reason, 'INSUFFICIENT_MARGIN')
})

test('parseOrderResponse treats an unrecognised shape as a non-fill rather than throwing', () => {
  const result = parseOrderResponse({})
  assert.equal(result.filled, false)
  assert.equal(result.reason, 'unknown response shape')
})

test('formatStopPrice rounds to the given instrument precision', () => {
  assert.equal(formatStopPrice(1.0999949, 5), '1.09999')
  assert.equal(formatStopPrice(147.29999, 3), '147.300')
})

test('buildClientOrderId is deterministic for the same pair and signal date', () => {
  const a = buildClientOrderId('EUR_USD', '2026-01-04T00:00:00Z')
  const b = buildClientOrderId('EUR_USD', '2026-01-04T00:00:00Z')
  assert.equal(a, b)
  const c = buildClientOrderId('GBP_USD', '2026-01-04T00:00:00Z')
  assert.notEqual(a, c)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test bridge/trading-orders.test.mjs`
Expected: FAIL — `bridge/trading-orders.mjs` does not exist yet.

- [ ] **Step 3: Write the implementation**

Create `bridge/trading-orders.mjs`:

```js
/**
 * OANDA order placement/closing for live trading. Pure response-parsing
 * and formatting helpers are exported and tested directly; the network
 * calls that use them are appended in a later step and are not unit-tested
 * (same reasoning as fetchPricingOnce/fetchCandlesOnce — real network
 * calls, verified manually).
 */

/**
 * A 200/201 HTTP response from OANDA's order endpoint does NOT mean the
 * order filled — the response body's transaction carries the real
 * outcome. This is the one place that distinction is made; callers must
 * never treat a successful HTTP status alone as "the trade happened".
 */
export function parseOrderResponse(json) {
  if (json?.orderFillTransaction) {
    const t = json.orderFillTransaction
    return {
      filled: true,
      fillPrice: Number(t.price),
      tradeId: t.tradeOpened?.tradeID ?? null,
    }
  }
  if (json?.orderCancelTransaction) {
    return { filled: false, reason: json.orderCancelTransaction.reason ?? 'cancelled' }
  }
  if (json?.orderRejectTransaction) {
    return { filled: false, reason: json.orderRejectTransaction.rejectReason ?? 'rejected' }
  }
  return { filled: false, reason: 'unknown response shape' }
}

/**
 * OANDA rejects a stop price with the wrong decimal precision for the
 * instrument (JPY pairs: 2-3 decimals; most others: 4-5) — this must be
 * driven by the instrument's real displayPrecision, fetched at call time,
 * never hard-coded per pair.
 */
export function formatStopPrice(price, precision) {
  return price.toFixed(precision)
}

/**
 * Deterministic per pair+signal so the SAME signal can never produce two
 * accepted orders even if a check-then-act race slips past the in-process
 * lock — OANDA itself rejects a duplicate clientExtensions.id, which is
 * the real backstop, not just the in-memory guard.
 */
export function buildClientOrderId(pair, signalTime) {
  return `jarvis-${pair}-${String(signalTime).slice(0, 10)}`
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test bridge/trading-orders.test.mjs`
Expected: PASS, all 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add bridge/trading-orders.mjs bridge/trading-orders.test.mjs
git commit -m "trading: add order-response parsing and formatting helpers"
```

---

### Task 5: OANDA network calls (orders, positions, account)

**Files:**
- Modify: `bridge/trading-orders.mjs`

- [ ] **Step 1: Write the implementation**

No new unit tests — real network calls, same reasoning as `fetchPricingOnce`/`fetchCandlesOnce`. Append to `bridge/trading-orders.mjs`:

```js
import { openRemote, vetTarget, PROXY_UA } from './net.mjs'

const FETCH_TIMEOUT_MS = 8000
const MAX_RESPONSE_BYTES = 512 * 1024

async function readJsonBody(res, maxBytes) {
  const chunks = []
  let size = 0
  for await (const chunk of res) {
    size += chunk.length
    if (size > maxBytes) {
      res.destroy()
      throw new Error('oanda response too large')
    }
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

async function oandaRequest({ host, accountId, apiKey, method, path, body }) {
  const url = vetTarget(`${host}/v3/accounts/${encodeURIComponent(accountId)}${path}`)
  const headers = {
    'user-agent': PROXY_UA,
    authorization: `Bearer ${apiKey}`,
    accept: 'application/json',
  }
  if (body) headers['content-type'] = 'application/json'
  const { res } = await openRemote(url, headers, FETCH_TIMEOUT_MS, {
    method,
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await readJsonBody(res, MAX_RESPONSE_BYTES)
  return { status: res.statusCode ?? 0, json }
}

/**
 * displayPrecision for one instrument, e.g. 5 for EUR_USD, 3 for USD_JPY.
 * Fetched fresh rather than hard-coded per pair — see formatStopPrice's
 * comment for why a wrong precision gets an order rejected outright.
 */
export async function fetchInstrumentPrecision({ host, accountId, apiKey, pair }) {
  const { json } = await oandaRequest({
    host, accountId, apiKey, method: 'GET',
    path: `/instruments?instruments=${encodeURIComponent(pair)}`,
  })
  const instrument = json?.instruments?.[0]
  return instrument?.displayPrecision ?? 5
}

/** Every currently open position, keyed by instrument. */
export async function fetchOpenPositions({ host, accountId, apiKey }) {
  const { json } = await oandaRequest({
    host, accountId, apiKey, method: 'GET', path: '/openPositions',
  })
  const out = {}
  for (const p of json?.positions ?? []) {
    const longUnits = Number(p.long?.units ?? 0)
    const shortUnits = Number(p.short?.units ?? 0)
    if (longUnits !== 0 || shortUnits !== 0) out[p.instrument] = { longUnits, shortUnits }
  }
  return out
}

/** Realized + unrealized P&L for the account, in account currency. */
export async function fetchAccountPL({ host, accountId, apiKey }) {
  const { json } = await oandaRequest({ host, accountId, apiKey, method: 'GET', path: '' })
  return {
    unrealizedPL: Number(json?.account?.unrealizedPL ?? 0),
    realizedPL: Number(json?.account?.pl ?? 0),
  }
}

/**
 * Places a long market order with a stop-loss attached. Returns
 * parseOrderResponse's result — callers must check `.filled` before
 * treating the trade as real; see parseOrderResponse's doc comment.
 */
export async function placeMarketOrder({ host, accountId, apiKey, pair, units, stopLossPrice, clientOrderId }) {
  const { json } = await oandaRequest({
    host, accountId, apiKey, method: 'POST', path: '/orders',
    body: {
      order: {
        type: 'MARKET',
        instrument: pair,
        units: String(Math.abs(Math.round(units))),
        timeInForce: 'FOK',
        positionFill: 'DEFAULT',
        stopLossOnFill: { price: stopLossPrice },
        clientExtensions: { id: clientOrderId },
      },
    },
  })
  return parseOrderResponse(json)
}

/** Closes the entire long position for one instrument. */
export async function closeLongPosition({ host, accountId, apiKey, pair }) {
  const { json } = await oandaRequest({
    host, accountId, apiKey, method: 'PUT',
    path: `/positions/${encodeURIComponent(pair)}/close`,
    body: { longUnits: 'ALL' },
  })
  return json
}
```

Note: `openRemote` in `net.mjs` was written for GET requests (see phase 1/3's usage). Check its current signature in `bridge/net.mjs` before writing this step — if it doesn't accept a `method`/`body` option as shown above, extend `openRemote` (or add a small `openRemoteWithBody` variant beside it in `net.mjs`) to support POST/PUT with a JSON body, routed through the exact same `vetTarget`/SSRF-guard/redirect-handling logic as the existing GET path — do not bypass that guard for these new calls. This is the one place in this task where you may need to touch `net.mjs`; keep the change minimal (support an optional `method` and `body`, default `method: 'GET'` so every existing caller is unaffected) and re-run `node --test bridge/forex.test.mjs bridge/backtest.test.mjs` afterward to confirm nothing there broke.

- [ ] **Step 2: Verify**

Run: `node --check bridge/trading-orders.mjs`
Expected: no output.

Run: `node --test bridge/trading-orders.test.mjs`
Expected: PASS — confirms the new imports don't throw at load time.

If you modified `net.mjs`, also run: `node --test bridge/forex.test.mjs bridge/backtest.test.mjs`
Expected: PASS, unchanged.

- [ ] **Step 3: Commit**

```bash
git add bridge/trading-orders.mjs bridge/net.mjs
git commit -m "trading: add OANDA order placement, position, and account calls"
```

---

### Task 6: Trade journal

**Files:**
- Create: `bridge/trading.mjs`
- Test: `bridge/trading.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `bridge/trading.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendJournalEntry, readJournalTail } from './trading.mjs'

test('appendJournalEntry writes one JSON line per call', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-journal-'))
  const path = join(dir, 'journal.jsonl')
  await appendJournalEntry(path, { pair: 'EUR_USD', event: 'enter', units: 1000 })
  await appendJournalEntry(path, { pair: 'EUR_USD', event: 'exit', units: 1000 })
  const content = await readFile(path, 'utf8')
  const lines = content.trim().split('\n')
  assert.equal(lines.length, 2)
  const first = JSON.parse(lines[0])
  assert.equal(first.pair, 'EUR_USD')
  assert.equal(first.event, 'enter')
  assert.ok(typeof first.at === 'string') // a timestamp was added
})

test('appendJournalEntry creates the parent directory if missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-journal-'))
  const path = join(dir, 'nested', 'journal.jsonl')
  await appendJournalEntry(path, { pair: 'GBP_USD', event: 'enter', units: 500 })
  const content = await readFile(path, 'utf8')
  assert.equal(JSON.parse(content.trim()).pair, 'GBP_USD')
})

test('readJournalTail returns the last N entries, most recent last', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-journal-'))
  const path = join(dir, 'journal.jsonl')
  for (let i = 0; i < 5; i++) {
    await appendJournalEntry(path, { pair: 'EUR_USD', event: 'enter', units: i })
  }
  const tail = await readJournalTail(path, 3)
  assert.deepEqual(tail.map((e) => e.units), [2, 3, 4])
})

test('readJournalTail returns an empty array if the file does not exist yet', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-journal-'))
  const tail = await readJournalTail(join(dir, 'nope.jsonl'), 5)
  assert.deepEqual(tail, [])
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test bridge/trading.test.mjs`
Expected: FAIL — `bridge/trading.mjs` does not exist yet.

- [ ] **Step 3: Write the implementation**

Create `bridge/trading.mjs`:

```js
/**
 * The trading poller, trade journal, boot reconciliation, and the two
 * trading MCP servers. Everything here orchestrates the pure functions in
 * trading-signal.mjs/trading-risk.mjs and the network calls in
 * trading-orders.mjs — this file owns state (the journal, the halt flag)
 * and timing, not strategy or risk math.
 */

import { mkdir, appendFile, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * The durable system of record. A proactive spoken announcement is a
 * convenience layered on top of this — if the browser tab is closed when a
 * trade fires, the journal still has it, which the WebSocket push alone
 * would not guarantee.
 */
export async function appendJournalEntry(path, entry) {
  await mkdir(dirname(path), { recursive: true })
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry })
  await appendFile(path, line + '\n', 'utf8')
}

/** Most recent `n` journal entries, oldest first (i.e. most recent last). */
export async function readJournalTail(path, n) {
  let content
  try {
    content = await readFile(path, 'utf8')
  } catch {
    return []
  }
  const lines = content.trim().split('\n').filter(Boolean)
  return lines.slice(-n).map((line) => JSON.parse(line))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test bridge/trading.test.mjs`
Expected: PASS, all 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add bridge/trading.mjs bridge/trading.test.mjs
git commit -m "trading: add the durable trade journal"
```

---

### Task 7: Boot reconciliation

**Files:**
- Modify: `bridge/trading.mjs`
- Modify: `bridge/trading.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `bridge/trading.test.mjs`:

```js
import { reconcileOpenPositions } from './trading.mjs'

test('reconcileOpenPositions reports no findings when open positions match the configured set exactly', () => {
  const openPositions = { EUR_USD: { longUnits: 1000, shortUnits: 0 } }
  const result = reconcileOpenPositions(openPositions, ['EUR_USD'], { EUR_USD: true })
  assert.deepEqual(result.unexpected, [])
  assert.deepEqual(result.missingStopLoss, [])
})

test('reconcileOpenPositions flags a position for a pair not in the configured list', () => {
  const openPositions = { USD_JPY: { longUnits: 500, shortUnits: 0 } }
  const result = reconcileOpenPositions(openPositions, ['EUR_USD'], { USD_JPY: true })
  assert.deepEqual(result.unexpected, ['USD_JPY'])
})

test('reconcileOpenPositions flags a configured-pair position with no known stop-loss', () => {
  const openPositions = { EUR_USD: { longUnits: 1000, shortUnits: 0 } }
  // hasStopLoss map says false (or the pair is simply absent from it)
  const result = reconcileOpenPositions(openPositions, ['EUR_USD'], {})
  assert.deepEqual(result.missingStopLoss, ['EUR_USD'])
})

test('reconcileOpenPositions flags an unexpected short position regardless of the long-only strategy', () => {
  const openPositions = { EUR_USD: { longUnits: 0, shortUnits: 500 } }
  const result = reconcileOpenPositions(openPositions, ['EUR_USD'], { EUR_USD: true })
  assert.deepEqual(result.unexpectedShorts, ['EUR_USD'])
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test bridge/trading.test.mjs`
Expected: FAIL — `reconcileOpenPositions` is not exported yet.

- [ ] **Step 3: Write the implementation**

Append to `bridge/trading.mjs`:

```js
/**
 * Run once at boot, before the poller starts, against OANDA's real open
 * positions — never trust an assumption about what should be open. Three
 * findings, each requiring a different response from the caller:
 *   - unexpected: a position for a pair not in JARVIS_TRADING_PAIRS.
 *     Adopted in monitor-only mode by the caller, never re-entered.
 *   - missingStopLoss: a configured pair's position with no confirmed
 *     stop-loss (from a prior fill's tradeId, tracked by the caller in
 *     `hasStopLoss`). Logged as a loud warning requiring manual attention.
 *   - unexpectedShorts: any short exposure at all, since the strategy is
 *     long-only — closeLongPosition would never touch this, so it must be
 *     surfaced rather than silently ignored.
 */
export function reconcileOpenPositions(openPositions, configuredPairs, hasStopLoss) {
  const configured = new Set(configuredPairs)
  const unexpected = []
  const missingStopLoss = []
  const unexpectedShorts = []

  for (const [pair, position] of Object.entries(openPositions)) {
    if (position.shortUnits !== 0) unexpectedShorts.push(pair)
    if (position.longUnits === 0) continue
    if (!configured.has(pair)) {
      unexpected.push(pair)
      continue
    }
    if (!hasStopLoss[pair]) missingStopLoss.push(pair)
  }

  return { unexpected, missingStopLoss, unexpectedShorts }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test bridge/trading.test.mjs`
Expected: PASS, all tests in the file green.

- [ ] **Step 5: Commit**

```bash
git add bridge/trading.mjs bridge/trading.test.mjs
git commit -m "trading: add boot-time open-position reconciliation"
```

---

### Task 8: The poller and MCP tools

**Files:**
- Modify: `bridge/trading.mjs`

- [ ] **Step 1: Write the implementation**

No new unit tests — this orchestrates already-tested pure functions plus network calls, same shape as `forex.mjs`'s `initForex`/`startForexPoller`. Append to `bridge/trading.mjs`:

```js
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { resolveEnv, hostFor } from './forex.mjs'
import { fetchCandlesOnce } from './backtest.mjs'
import { detectLiveSignal } from './trading-signal.mjs'
import { computeATR, computeStopLossPrice, checkPositionSize, checkTotalExposure, checkDailyLossHalt } from './trading-risk.mjs'
import {
  fetchInstrumentPrecision, fetchOpenPositions, fetchAccountPL,
  placeMarketOrder, closeLongPosition, formatStopPrice, buildClientOrderId,
} from './trading-orders.mjs'

const JOURNAL_PATH = new URL('./data/trading-journal.jsonl', import.meta.url).pathname

const state = {
  armed: false,
  halted: false,
  haltReason: null,
  polling: false,
  timer: null,
  hasStopLoss: {}, // pair -> boolean, tracked from fill confirmations this run
  onAnnounce: null, // set by initTrading, pushes to the browser
}

function haltTrading(reason) {
  state.halted = true
  state.haltReason = reason
  console.error(`[jarvis:trading] HALTED — ${reason}`)
}

async function announce(text) {
  console.log(`[jarvis:trading] ${text}`)
  state.onAnnounce?.(text)
}

/**
 * One sweep across every configured pair. A single lock for the WHOLE
 * sweep, not per-pair — a second tick is skipped entirely if the previous
 * one hasn't finished, matching phase 1's poller philosophy but scoped to
 * the multi-pair unit of work rather than one fetch.
 */
async function pollOnce(config) {
  if (state.polling || state.halted) return
  state.polling = true
  try {
    const { realizedPL, unrealizedPL } = await fetchAccountPL(config)
    if (checkDailyLossHalt(realizedPL, unrealizedPL, config.maxDailyLoss)) {
      haltTrading(`daily loss cap reached (realized ${realizedPL} + unrealized ${unrealizedPL})`)
      return
    }

    for (const pair of config.pairs) {
      const candles = await fetchCandlesOnce({ ...config, pair })
      if (candles.length < config.slowPeriod + 1) continue

      // Only touch OANDA's real position state when there's a candidate
      // signal — avoids an API call on every pair on every tick when
      // nothing changed.
      const provisionalSignal = detectLiveSignal(candles, null, config)
      if (provisionalSignal === 'none') continue

      const openPositions = await fetchOpenPositions(config)
      const currentPosition = openPositions[pair]?.longUnits > 0 ? openPositions[pair] : null
      const signal = detectLiveSignal(candles, currentPosition, config)
      if (signal === 'none') continue

      if (signal === 'enter') {
        const totalOpenUnits = Object.values(openPositions).reduce((sum, p) => sum + p.longUnits, 0)
        if (!checkPositionSize(config.maxPositionUnits, config.maxPositionUnits)) continue
        if (!checkTotalExposure(totalOpenUnits, config.maxPositionUnits, config.maxTotalUnits)) {
          await announce(`Skipped a ${pair} entry — it would exceed the total exposure limit.`)
          continue
        }

        const atr = computeATR(candles)
        if (atr === null) continue
        const entryPrice = candles[candles.length - 1].close
        const stopPrice = computeStopLossPrice(entryPrice, atr, config.atrStopMultiplier)
        const precision = await fetchInstrumentPrecision({ ...config, pair })
        const clientOrderId = buildClientOrderId(pair, candles[candles.length - 1].time)

        const result = await placeMarketOrder({
          ...config, pair,
          units: config.maxPositionUnits,
          stopLossPrice: formatStopPrice(stopPrice, precision),
          clientOrderId,
        })

        await appendJournalEntry(JOURNAL_PATH, { pair, event: 'enter', ...result })
        if (result.filled) {
          state.hasStopLoss[pair] = true
          await announce(`Opened a ${pair} position, ${config.maxPositionUnits} units.`)
        } else {
          await announce(`${pair} entry did not fill: ${result.reason}.`)
        }
      } else if (signal === 'exit') {
        const closeResult = await closeLongPosition({ ...config, pair })
        await appendJournalEntry(JOURNAL_PATH, { pair, event: 'exit', result: closeResult })
        delete state.hasStopLoss[pair]
        await announce(`Closed the ${pair} position.`)
      }
    }
  } catch (err) {
    console.error(`[jarvis:trading] sweep failed: ${err.message}`)
  } finally {
    state.polling = false
  }
}

function startPoller(config) {
  const tick = async () => {
    await pollOnce(config)
    state.timer = setTimeout(tick, config.pollIntervalMs)
  }
  void tick()
  return () => {
    if (state.timer) clearTimeout(state.timer)
  }
}

/**
 * Boot-time setup. Trading only starts if JARVIS_TRADING_ENABLED and
 * JARVIS_TRADING_ARM are both true (checked fresh every boot — the arm
 * flag is never persisted, so a crash-and-restart always comes up
 * halted-equivalent unless the person restarting it explicitly sets this
 * again) and every mandatory risk-limit env var is present.
 */
export async function initTrading(onAnnounce) {
  state.onAnnounce = onAnnounce

  if (process.env.JARVIS_TRADING_ENABLED !== 'true') {
    console.log('[jarvis:trading] disabled — set JARVIS_TRADING_ENABLED=true to enable')
    return null
  }
  if (process.env.JARVIS_TRADING_ARM !== 'true') {
    console.error('[jarvis:trading] disabled — JARVIS_TRADING_ARM=true is required at every boot to trade')
    return null
  }

  const apiKey = process.env.JARVIS_OANDA_API_KEY
  const accountId = process.env.JARVIS_OANDA_ACCOUNT_ID
  const pairsRaw = process.env.JARVIS_TRADING_PAIRS
  const maxPositionUnits = Number(process.env.JARVIS_TRADING_MAX_POSITION_UNITS)
  const maxTotalUnits = Number(process.env.JARVIS_TRADING_MAX_TOTAL_UNITS)
  const maxDailyLoss = Number(process.env.JARVIS_TRADING_MAX_DAILY_LOSS)
  const atrStopMultiplier = Number(process.env.JARVIS_TRADING_ATR_STOP_MULTIPLIER)
  const pollIntervalMs = Number(process.env.JARVIS_TRADING_POLL_INTERVAL_MS)

  const missing = []
  if (!apiKey) missing.push('JARVIS_OANDA_API_KEY')
  if (!accountId) missing.push('JARVIS_OANDA_ACCOUNT_ID')
  if (!pairsRaw) missing.push('JARVIS_TRADING_PAIRS')
  if (!Number.isFinite(maxPositionUnits) || maxPositionUnits <= 0) missing.push('JARVIS_TRADING_MAX_POSITION_UNITS')
  if (!Number.isFinite(maxTotalUnits) || maxTotalUnits <= 0) missing.push('JARVIS_TRADING_MAX_TOTAL_UNITS')
  if (!Number.isFinite(maxDailyLoss) || maxDailyLoss <= 0) missing.push('JARVIS_TRADING_MAX_DAILY_LOSS')
  if (!Number.isFinite(atrStopMultiplier) || atrStopMultiplier <= 0) missing.push('JARVIS_TRADING_ATR_STOP_MULTIPLIER')
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) missing.push('JARVIS_TRADING_POLL_INTERVAL_MS')
  if (missing.length) {
    console.error(`[jarvis:trading] disabled — missing required config: ${missing.join(', ')}`)
    return null
  }

  let env
  try {
    env = resolveEnv()
  } catch (err) {
    console.error(`[jarvis:trading] disabled — ${err.message}`)
    return null
  }

  const config = {
    host: hostFor(env), accountId, apiKey,
    pairs: pairsRaw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
    fastPeriod: 10, slowPeriod: 30,
    maxPositionUnits, maxTotalUnits, maxDailyLoss, atrStopMultiplier, pollIntervalMs,
  }

  const openPositions = await fetchOpenPositions(config)
  const reconciliation = reconcileOpenPositions(openPositions, config.pairs, state.hasStopLoss)
  if (reconciliation.unexpected.length) {
    console.error(`[jarvis:trading] unexpected open positions on boot (adopted, monitor-only): ${reconciliation.unexpected.join(', ')}`)
  }
  if (reconciliation.missingStopLoss.length) {
    console.error(`[jarvis:trading] WARNING — open position(s) with no confirmed stop-loss: ${reconciliation.missingStopLoss.join(', ')}`)
  }
  if (reconciliation.unexpectedShorts.length) {
    console.error(`[jarvis:trading] WARNING — unexpected short exposure (this strategy is long-only): ${reconciliation.unexpectedShorts.join(', ')}`)
  }

  state.armed = true
  console.log(`[jarvis:trading] armed — ${env} — pairs ${config.pairs.join(', ')}`)
  startPoller(config)
  return config
}

export function tradingServer() {
  return createSdkMcpServer({
    name: 'jarvis_trading',
    version: '1.0.0',
    instructions: 'Read-only status for the autonomous forex trading loop.',
    tools: [
      tool('trading_status', 'Report whether autonomous trading is armed, halted, and today\'s P&L.', {}, async () => {
        const tail = await readJournalTail(JOURNAL_PATH, 5)
        const lines = [
          state.armed ? (state.halted ? `Halted — ${state.haltReason}` : 'Armed and running') : 'Not armed',
          `Recent activity: ${tail.length ? tail.map((e) => `${e.pair} ${e.event}`).join(', ') : 'none'}`,
        ]
        return { content: [{ type: 'text', text: lines.join('. ') }] }
      }),
    ],
  })
}

export function tradingControlServer() {
  return createSdkMcpServer({
    name: 'jarvis_trading_control',
    version: '1.0.0',
    instructions: 'The trading kill-switch. Always available, regardless of write permissions.',
    tools: [
      tool('trading_halt', 'Immediately stop autonomous trading. Existing stop-losses stay in place.', {}, async () => {
        haltTrading('halted by voice command')
        return { content: [{ type: 'text', text: 'Trading halted. Existing positions keep their stop-losses.' }] }
      }),
    ],
  })
}
```

Note: `import { appendJournalEntry, readJournalTail, reconcileOpenPositions } from` — these were defined earlier in this same file (Tasks 6-7), so no import line is needed for them; they're already in scope. Also create the directory `bridge/data/` (an empty `.gitkeep` file is enough) and add `bridge/data/*.jsonl` to `.gitignore` — the journal is runtime state, not something to commit.

- [ ] **Step 2: Add the gitignore entry and directory**

```bash
mkdir -p bridge/data
touch bridge/data/.gitkeep
```

Add to `.gitignore`:

```
bridge/data/*.jsonl
```

- [ ] **Step 3: Verify**

Run: `node --check bridge/trading.mjs`
Expected: no output.

Run: `node --test bridge/trading.test.mjs`
Expected: PASS — confirms the new imports (createSdkMcpServer, tool, z, and the cross-module imports) don't throw at load time.

- [ ] **Step 4: Commit**

```bash
git add bridge/trading.mjs bridge/data/.gitkeep .gitignore
git commit -m "trading: add the poller, boot arming, and both MCP servers"
```

---

### Task 9: Wire into server.mjs

**Files:**
- Modify: `bridge/server.mjs`

- [ ] **Step 1: Import the new module**

At the top of `bridge/server.mjs`, alongside the other bridge module imports:

```js
import { backtestServer } from './backtest.mjs'
import { initTrading, tradingServer, tradingControlServer } from './trading.mjs'
```

- [ ] **Step 2: Call `initTrading()` at boot**

Near where `initForex()` is called (top-level `await`), add:

```js
const TRADING_CONFIG = await initTrading((text) => {
  // Pushed to every currently-connected client. If none is connected the
  // announcement is simply not spoken — the journal (see trading.mjs) is
  // the actual record, so nothing is lost, only the spoken convenience.
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) {
      client.send(JSON.stringify({ type: 'announce', text }))
    }
  }
})
```

This must be placed AFTER `const wss = new WebSocketServer(...)` is defined (since it references `wss.clients`) — check the current file for where `wss` is constructed relative to where `initForex()` is called, and place this call after `wss` exists, adjusting if the surrounding code structure requires it.

- [ ] **Step 3: Register both MCP servers**

Inside the `mcpServers` object passed to `query()`, add both next to `jarvis_backtest`:

```js
        jarvis_backtest: backtestServer(),
        jarvis_trading: tradingServer(),
        jarvis_trading_control: tradingControlServer(),
```

- [ ] **Step 4: Allow both in `decideTool`**

Add next to the `jarvis_backtest` case inside `decideTool`:

```js
    if (server === 'jarvis_backtest') return true

    // Read-only status. No orders are placed by this tool.
    if (server === 'jarvis_trading') return true

    // The kill-switch. Always allowed, deliberately outside ALLOW_WRITES —
    // halting is monotonic and safe from any caller; see trading.mjs.
    if (server === 'jarvis_trading_control') return true
```

- [ ] **Step 5: Log trading status in the boot banner**

Near the other boot `console.log` lines:

```js
console.log(
  TRADING_CONFIG
    ? `[jarvis] trading active`
    : '[jarvis] trading disabled — set JARVIS_TRADING_ENABLED=true and JARVIS_TRADING_ARM=true to enable',
)
```

- [ ] **Step 6: Verify**

Run: `node --check bridge/server.mjs`
Expected: no output.

Run: `node --test bridge/**/*.test.mjs`
Expected: all tests across every phase pass.

Run the bridge with no trading env vars set: `node bridge/server.mjs` (kill it after confirming the boot log)
Expected log includes `[jarvis:trading] disabled — set JARVIS_TRADING_ENABLED=true to enable` and `[jarvis] trading disabled — ...`, and the bridge otherwise starts normally (forex/backtest features unaffected).

- [ ] **Step 7: Commit**

```bash
git add bridge/server.mjs
git commit -m "trading: wire the trading poller and MCP tools into the bridge"
```

---

### Task 10: Frontend — proactive announcements

**Files:**
- Modify: `src/lib/bridge.ts`
- Modify: `src/App.tsx`

- [ ] **Step 1: Add the out-of-band announce handler**

In `src/lib/bridge.ts`, add a new watcher next to `watchUi` (following the exact same pattern):

```ts
/** Trade announcements — pushed outside the normal turn flow, spoken
 *  immediately rather than waiting for a question. */
let onAnnounce: ((text: string) => void) | null = null
export function watchAnnounce(fn: (text: string) => void) {
  onAnnounce = fn
}
```

In the `dispatch` function's message handler, add a branch (alongside the existing `else if (msg.type === 'ui' ...)` branch):

```ts
    } else if (msg.type === 'announce' && msg.text) {
      onAnnounce?.(msg.text)
    }
```

- [ ] **Step 2: Speak and transcript an announcement**

In `src/App.tsx`, import `watchAnnounce` alongside the existing `watchPanels`/`watchBlades` imports (same import block, around line 23-24):

```tsx
  watchPanels,
  watchBlades,
  watchAnnounce,
```

Near the existing `watchPanels(...)`/`watchBlades(...)` subscriptions (around line 366-367), add:

```tsx
    watchAnnounce((text) => {
      store.getState().pushTurn({ id: newId(), role: 'jarvis', text })
      const spk = createSpeaker()
      spk.say(text)
    })
```

Check the current file for the exact name of the turn-id generator used elsewhere (referenced above as `newId()` — confirm the actual helper name used at the existing `pushTurn` call around line 138, e.g. it may be a different function or inline `crypto.randomUUID()`) and match it exactly, rather than assuming `newId` exists.

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit -p tsconfig.app.json`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/lib/bridge.ts src/App.tsx
git commit -m "trading: speak and transcript proactive trade announcements"
```

---

### Task 11: Env var documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document every new env var**

In `README.md`, in the existing `### Bridge` config table, add:

```markdown
| `JARVIS_TRADING_ENABLED` | unset | Must be `true` for the trading poller to start at all. |
| `JARVIS_TRADING_ARM` | unset | Must be `true` at every boot for trading to actually run — never persisted, a restart always comes up halted without it. |
| `JARVIS_TRADING_PAIRS` | — | Comma-separated pairs to trade, e.g. `EUR_USD,GBP_USD`. Required if trading is enabled. |
| `JARVIS_TRADING_MAX_POSITION_UNITS` | — | Hard cap on units per trade. Required. |
| `JARVIS_TRADING_MAX_TOTAL_UNITS` | — | Hard cap on summed units across all open positions. Required. |
| `JARVIS_TRADING_MAX_DAILY_LOSS` | — | Account-currency loss amount that halts trading for the rest of the day. Required. |
| `JARVIS_TRADING_ATR_STOP_MULTIPLIER` | — | Stop-loss distance as a multiple of the 14-period ATR. Required. |
| `JARVIS_TRADING_POLL_INTERVAL_MS` | — | How often the trading loop sweeps all pairs. Required. |
```

- [ ] **Step 2: Add a prominent safety section**

Add a new `### ⚠️ Autonomous trading` section after the Backtesting section (added in phase 3), before `## Enabling actions`:

```markdown
### ⚠️ Autonomous trading

Phase 4 lets JARVIS place real OANDA orders on its own, using the same
moving-average-crossover strategy as backtesting. This is off by default
and stays off unless you explicitly set THREE things:

```bash
JARVIS_TRADING_ENABLED=true
JARVIS_TRADING_ARM=true          # required at EVERY boot — never persisted
JARVIS_OANDA_ALLOW_LIVE=true     # only if you want real money, not practice
```

Say "Jarvis, stop trading" at any time — `trading_halt` is always available
and stops the loop immediately, regardless of any other permission setting.
Existing positions keep their stop-losses either way; halting only stops
new entries. Resuming after a halt requires restarting the bridge with
`JARVIS_TRADING_ARM=true` set again — there is no in-conversation resume,
by design.

**Test against the OANDA practice account first, extensively, before ever
setting `JARVIS_OANDA_ALLOW_LIVE=true` here.** See
`docs/superpowers/specs/2026-09-14-forex-trading-design.md` for the full
safety design.
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "trading: document the new env vars and the safety switches"
```

---

### Task 12: Manual verification (practice account only)

**Files:** none (verification only)

- [ ] **Step 1: Start the bridge against the OANDA practice account**

```bash
JARVIS_OANDA_API_KEY=<practice-key> \
JARVIS_OANDA_ACCOUNT_ID=<practice-account-id> \
JARVIS_TRADING_ENABLED=true \
JARVIS_TRADING_ARM=true \
JARVIS_TRADING_PAIRS=EUR_USD \
JARVIS_TRADING_MAX_POSITION_UNITS=100 \
JARVIS_TRADING_MAX_TOTAL_UNITS=100 \
JARVIS_TRADING_MAX_DAILY_LOSS=50 \
JARVIS_TRADING_ATR_STOP_MULTIPLIER=2 \
JARVIS_TRADING_POLL_INTERVAL_MS=60000 \
npm run bridge
```

**Do NOT set `JARVIS_OANDA_ALLOW_LIVE=true` for this step.** Confirm the boot log shows `[jarvis:trading] armed — practice — pairs EUR_USD` and `[jarvis] trading active`.

- [ ] **Step 2: Verify the kill-switch**

With the app running, say "Jarvis, stop trading" (or call `trading_halt` directly via the MCP tool if testing headless). Confirm the bridge logs `[jarvis:trading] HALTED — halted via voice command` and `trading_status` subsequently reports "Halted".

- [ ] **Step 3: Verify boot reconciliation**

Manually place a small trade in the OANDA practice account's own web UI for a pair NOT in `JARVIS_TRADING_PAIRS` (e.g. `USD_JPY`), then restart the bridge. Confirm the boot log includes `unexpected open positions on boot (adopted, monitor-only): USD_JPY`. Close that manual position afterward.

- [ ] **Step 4: Verify a real entry/exit cycle (practice only)**

This step may require waiting for an actual crossover, or temporarily lowering `JARVIS_TRADING_MAX_POSITION_UNITS`/using a fast-moving test window to force a signal — use your judgment on how to observe one real cycle. Confirm: an order appears in the OANDA practice account with a stop-loss attached, `bridge/data/trading-journal.jsonl` gets an `enter` line, JARVIS speaks an announcement unprompted, and on the eventual exit signal the position closes and a matching `exit` line appears in the journal.

- [ ] **Step 5: Confirm live mode is still off by default**

Restart the bridge with everything the same EXCEPT omit `JARVIS_OANDA_ALLOW_LIVE` entirely and confirm trading still only touches the practice account (this should already be true from Step 1, but re-confirm explicitly before ever setting the live flag in this project).

---

## Self-Review Notes

- **Spec coverage:** two-plus-one activation gates → Task 8 (`initTrading`'s env checks). Mandatory limits with no permissive defaults → Task 8's `missing` array (bridge refuses to start trading, not just warns). Daily-loss halt reading OANDA's own P&L → Task 8 (`fetchAccountPL`) + Task 3 (`checkDailyLossHalt`) — never recomputed from candle deltas, closing the phase-3-inherited currency bug. Voice kill-switch, isolated server, logged → Task 8/9 (`jarvis_trading_control` as its own server, `haltTrading()` logs the reason). ATR-based stops → Task 2/3. Race safety (per-tick lock, fresh position query, idempotent client IDs) → Task 8's `pollOnce` (single `state.polling` guard for the whole sweep, `fetchOpenPositions` called fresh before any decision, `buildClientOrderId`). Order fill confirmation → Task 4/5 (`parseOrderResponse`, checked before recording a position as opened in Task 8). Recoverability (stop-loss survives a crash, boot reconciliation, durable journal) → Task 6/7/8. Live signal detection as a dedicated function → Task 1. Account-wide exposure cap → Task 3 (`checkTotalExposure`) + Task 8. Proactive announcements as convenience, not system of record → Task 6 (journal written before `announce()` is called in Task 8) + Task 10.
- **No placeholders:** every step has complete code; the two spots requiring the implementer to check current file state before a mechanical edit (Task 5's `net.mjs` signature check, Task 9's `wss` placement, Task 10's turn-id helper name) are explicitly flagged as "confirm before assuming" rather than silently guessed at, which is different from an unspecified requirement — the actual change to make in each case is fully specified.
- **Type/name consistency check:** `detectLiveSignal`, `computeATR`, `trueRange`, `computeStopLossPrice`, `checkPositionSize`, `checkTotalExposure`, `checkDailyLossHalt`, `parseOrderResponse`, `formatStopPrice`, `buildClientOrderId`, `fetchOpenPositions`, `fetchAccountPL`, `placeMarketOrder`, `closeLongPosition`, `appendJournalEntry`, `readJournalTail`, `reconcileOpenPositions`, `initTrading`, `tradingServer`, `tradingControlServer` are used identically everywhere they're referenced across all files in this plan.
