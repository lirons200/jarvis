# Forex Backtesting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a backtesting engine to JARVIS — historical OANDA candles → a moving-average-crossover strategy → performance stats — exposed as both a `backtest_run` MCP tool (voice) and a `scripts/backtest.mjs` CLI script, sharing one implementation.

**Architecture:** One new module, `bridge/backtest.mjs`, holding pure/testable functions (`parseCandles`, `movingAverageCrossoverStrategy`, `computeStats`) plus the network call (`fetchCandlesOnce`, reusing `net.mjs`'s SSRF-guarded client and `forex.mjs`'s `resolveEnv`/`hostFor` OANDA config helpers) and an MCP tool wrapper. The MCP tool returns plain text (numbers and a trade list) — JARVIS composes any `hud-*` blade markup himself from that text, the same pattern `forex_price` already uses; no HTML-building code is added to the bridge.

**Tech Stack:** Node.js (ESM), `zod` + `@anthropic-ai/claude-agent-sdk` (matching `forex.mjs`/`ui.mjs`), Node's built-in `node:test` runner (matching the existing `bridge/*.test.mjs` pattern).

**Depends on:** Phase 1 ([2026-09-13-forex-data-feed-design.md](../specs/2026-09-13-forex-data-feed-design.md)) for the `JARVIS_OANDA_*` env vars, `resolveEnv()`/`hostFor()` in `bridge/forex.mjs`, and the SSRF-guarded client in `bridge/net.mjs`. Does NOT depend on phase 2 (the ticker) — this is a separate historical-data path.

**Spec:** `C:\Users\irons\jarvis\docs\superpowers\specs\2026-09-14-forex-backtesting-design.md`

**Verified against OANDA docs (2026-09-14), with one item confirmed only from general OANDA v20 API knowledge, not a fresh doc fetch — flagged below:**
- Candle response shape confirmed via docs: `{ candles: [{ time, mid: { o, h, l, c }, volume, complete }] }` (using `price=M` for midpoint).
- **Endpoint path** (`GET /v3/instruments/{instrument}/candles`) and **max `count`** (commonly documented as 5000) were **not** confirmed via a fresh doc fetch this session (the docs site returned partial/404 responses for those specific pages) — Task 1 includes a real verification step against the live OANDA API as its first action, rather than trusting either the docs or training knowledge blindly.

---

## File Structure

- **Create:** `bridge/backtest.mjs` — candle parsing/fetching, the moving-average strategy, stats calculation, and the `backtest_run` MCP tool.
- **Create:** `bridge/backtest.test.mjs` — unit tests for `parseCandles`, `movingAverageCrossoverStrategy`, `computeStats`.
- **Create:** `scripts/backtest.mjs` — CLI wrapper around the same engine functions.
- **Modify:** `bridge/server.mjs` — register the `jarvis_backtest` MCP server, add a `decideTool` allow-rule.
- **Modify:** `package.json` — add a `backtest` npm script.
- **Modify:** `README.md` — document the CLI script.

---

### Task 1: Candle fetching and parsing

**Files:**
- Create: `bridge/backtest.mjs`
- Test: `bridge/backtest.test.mjs`

- [ ] **Step 1: Verify the OANDA candles endpoint against the live API before writing the parser**

This is a real-API check, not a unit test — run it manually once, using your own OANDA practice credentials, to confirm the endpoint path/shape before coding against it:

```bash
curl -s "https://api-fxpractice.oanda.com/v3/instruments/EUR_USD/candles?granularity=D&count=5&price=M" \
  -H "Authorization: Bearer $JARVIS_OANDA_API_KEY" | head -c 2000
```

Confirm: the request succeeds (not 404/400), the response has a top-level `candles` array, and each candle has `time`, `mid: { o, h, l, c }`, and `complete`. If the shape differs from this, adjust `parseCandles` in Step 3 below accordingly — do not silently assume the shape in the code sample matches without having checked.

If you don't have OANDA credentials available in your environment, skip this step and proceed with the shape as documented above (already confirmed via OANDA's docs), noting in your final report that the live-API check was not possible and should be done before this is trusted in production.

- [ ] **Step 2: Write the failing tests**

Create `bridge/backtest.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCandles } from './backtest.mjs'

test('parseCandles extracts OHLC from mid prices and drops incomplete candles', () => {
  const json = {
    candles: [
      { time: '2026-01-01T00:00:00Z', mid: { o: '1.1', h: '1.2', l: '1.0', c: '1.15' }, complete: true },
      { time: '2026-01-02T00:00:00Z', mid: { o: '1.15', h: '1.16', l: '1.14', c: '1.155' }, complete: false },
    ],
  }
  const candles = parseCandles(json)
  assert.equal(candles.length, 1)
  assert.deepEqual(candles[0], { time: '2026-01-01T00:00:00Z', open: 1.1, high: 1.2, low: 1.0, close: 1.15 })
})

test('parseCandles tolerates a missing candles array', () => {
  assert.deepEqual(parseCandles({}), [])
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test bridge/backtest.test.mjs`
Expected: FAIL — `bridge/backtest.mjs` does not exist yet.

- [ ] **Step 4: Write the implementation**

Create `bridge/backtest.mjs`:

```js
/**
 * Forex backtesting — historical OANDA candles, a moving-average-crossover
 * strategy, and stats, shared by the backtest_run MCP tool and
 * scripts/backtest.mjs. Pure/testable logic is kept separate from the one
 * network call, the same split bridge/forex.mjs uses.
 */

import { openRemote, vetTarget, PROXY_UA } from './net.mjs'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { resolveEnv, hostFor } from './forex.mjs'

/**
 * Parses one `/v3/instruments/{pair}/candles` response into a flat OHLC
 * series. Only complete candles are kept — OANDA includes the still-forming
 * current candle in some responses, and a partial bar would corrupt a
 * moving average computed over it.
 */
export function parseCandles(json) {
  return (json?.candles ?? [])
    .filter((c) => c.complete)
    .map((c) => ({
      time: c.time,
      open: Number(c.mid.o),
      high: Number(c.mid.h),
      low: Number(c.mid.l),
      close: Number(c.mid.c),
    }))
}

const FETCH_TIMEOUT_MS = 8000
const MAX_RESPONSE_BYTES = 1024 * 1024

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

/**
 * One candles request. Routed through net.mjs's SSRF-guarded client, same
 * as forex.mjs's fetchPricingOnce — even though OANDA's hosts are fixed, so
 * this can never silently diverge from that convention. `price=M` (mid) is
 * used rather than bid/ask, since this phase doesn't model spread.
 */
export async function fetchCandlesOnce({ host, accountId, apiKey, pair, granularity = 'D', count = 252 }) {
  const url = vetTarget(
    `${host}/v3/instruments/${encodeURIComponent(pair)}/candles` +
      `?granularity=${encodeURIComponent(granularity)}&count=${count}&price=M`,
  )
  const { res } = await openRemote(
    url,
    {
      'user-agent': PROXY_UA,
      authorization: `Bearer ${apiKey}`,
      accept: 'application/json',
    },
    FETCH_TIMEOUT_MS,
  )
  const status = res.statusCode ?? 0
  if (status !== 200) {
    res.resume()
    const err = new Error(`oanda candles request failed with status ${status}`)
    err.status = status
    throw err
  }
  const json = await readJsonBody(res, MAX_RESPONSE_BYTES)
  return parseCandles(json)
}
```

(The `resolveEnv, hostFor` import from `./forex.mjs` isn't used yet in this task — it's imported now because Task 4 needs it in this same file, and importing it here keeps the diff for Task 4 smaller. If your editor/linter flags an unused import at this point, that's expected and resolves in Task 4.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test bridge/backtest.test.mjs`
Expected: PASS, both tests green.

- [ ] **Step 6: Commit**

```bash
git add bridge/backtest.mjs bridge/backtest.test.mjs
git commit -m "backtest: fetch and parse OANDA historical candles"
```

---

### Task 2: Moving-average crossover strategy

**Files:**
- Modify: `bridge/backtest.mjs`
- Modify: `bridge/backtest.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `bridge/backtest.test.mjs`:

```js
import { movingAverageCrossoverStrategy } from './backtest.mjs'

test('movingAverageCrossoverStrategy finds one trade at the known crossover points', () => {
  const closes = [10, 10, 10, 12, 14, 16, 10, 8, 6]
  const candles = closes.map((close, i) => ({
    time: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
    open: close, high: close, low: close, close,
  }))
  const trades = movingAverageCrossoverStrategy(candles, { fastPeriod: 2, slowPeriod: 3 })
  assert.equal(trades.length, 1)
  assert.equal(trades[0].entryPrice, 12)
  assert.equal(trades[0].exitPrice, 10)
  assert.equal(trades[0].entryTime, '2026-01-04T00:00:00Z')
  assert.equal(trades[0].exitTime, '2026-01-07T00:00:00Z')
  assert.equal(trades[0].pnl, -2)
})

test('movingAverageCrossoverStrategy returns no trades when there is no crossover', () => {
  const candles = Array.from({ length: 10 }, (_, i) => ({
    time: `t${i}`, open: 10, high: 10, low: 10, close: 10,
  }))
  const trades = movingAverageCrossoverStrategy(candles, { fastPeriod: 2, slowPeriod: 3 })
  assert.deepEqual(trades, [])
})

test('movingAverageCrossoverStrategy leaves an unclosed position out of the trade list', () => {
  // Rises through a crossover and never comes back down — the open position
  // has no exit, so it must not appear as a completed trade.
  const closes = [10, 10, 10, 12, 14, 16, 18, 20, 22]
  const candles = closes.map((close, i) => ({
    time: `2026-02-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
    open: close, high: close, low: close, close,
  }))
  const trades = movingAverageCrossoverStrategy(candles, { fastPeriod: 2, slowPeriod: 3 })
  assert.deepEqual(trades, [])
})
```

The third test's expected trade count of `0` matters: the entry crossover happens (same as the first test, at index 3), but since the price keeps climbing there is no exit crossover in this window, so the position is still open when the series ends. `movingAverageCrossoverStrategy` must not report an open position as a completed trade.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test bridge/backtest.test.mjs`
Expected: FAIL — `movingAverageCrossoverStrategy` is not exported yet.

- [ ] **Step 3: Write the implementation**

Append to `bridge/backtest.mjs`:

```js
function sma(values, period, index) {
  if (index < period - 1) return null
  let sum = 0
  for (let i = index - period + 1; i <= index; i++) sum += values[i]
  return sum / period
}

/**
 * Long-only, one position at a time. Buys when the fast SMA crosses above
 * the slow SMA, closes when it crosses back below. A buy signal while
 * already positioned is ignored, as is a close signal while flat. An
 * un-closed position at the end of the series is dropped, not reported as
 * a trade — it never realised a P&L.
 *
 * A pure function (candles in, trades out) on purpose, so a second strategy
 * can be added later as a sibling function without touching this one or the
 * engine around it.
 */
export function movingAverageCrossoverStrategy(candles, { fastPeriod = 10, slowPeriod = 30 } = {}) {
  const closes = candles.map((c) => c.close)
  const trades = []
  let position = null
  let prevFast = null
  let prevSlow = null

  for (let i = 0; i < candles.length; i++) {
    const fast = sma(closes, fastPeriod, i)
    const slow = sma(closes, slowPeriod, i)

    if (fast !== null && slow !== null && prevFast !== null && prevSlow !== null) {
      const crossedUp = prevFast <= prevSlow && fast > slow
      const crossedDown = prevFast >= prevSlow && fast < slow

      if (crossedUp && !position) {
        position = { entryTime: candles[i].time, entryPrice: candles[i].close }
      } else if (crossedDown && position) {
        trades.push({
          entryTime: position.entryTime,
          entryPrice: position.entryPrice,
          exitTime: candles[i].time,
          exitPrice: candles[i].close,
          pnl: candles[i].close - position.entryPrice,
        })
        position = null
      }
    }

    if (fast !== null && slow !== null) {
      prevFast = fast
      prevSlow = slow
    }
  }

  return trades
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test bridge/backtest.test.mjs`
Expected: PASS, all tests in the file green.

- [ ] **Step 5: Commit**

```bash
git add bridge/backtest.mjs bridge/backtest.test.mjs
git commit -m "backtest: add the moving-average-crossover strategy"
```

---

### Task 3: Stats

**Files:**
- Modify: `bridge/backtest.mjs`
- Modify: `bridge/backtest.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `bridge/backtest.test.mjs`:

```js
import { computeStats } from './backtest.mjs'

test('computeStats computes return/win-rate/drawdown from a trade list', () => {
  const stats = computeStats([{ pnl: -2 }], 10000)
  assert.equal(stats.tradeCount, 1)
  assert.equal(stats.winRatePct, 0)
  assert.ok(Math.abs(stats.totalReturnPct - -0.02) < 1e-9)
  assert.ok(Math.abs(stats.maxDrawdownPct - 0.02) < 1e-9)
  assert.equal(stats.endingBalance, 9998)
})

test('computeStats reports a 100% win rate and zero drawdown for an all-winning sequence', () => {
  const stats = computeStats([{ pnl: 100 }, { pnl: 50 }], 1000)
  assert.equal(stats.winRatePct, 100)
  assert.equal(stats.maxDrawdownPct, 0)
  assert.equal(stats.endingBalance, 1150)
})

test('computeStats returns zeroed stats for an empty trade list', () => {
  const stats = computeStats([], 1000)
  assert.deepEqual(stats, {
    tradeCount: 0,
    totalReturnPct: 0,
    winRatePct: 0,
    maxDrawdownPct: 0,
    endingBalance: 1000,
  })
})

test('computeStats tracks drawdown across a rise then a fall, not just the final balance', () => {
  // Balance goes 1000 -> 1200 (peak) -> 1100 (150 down from peak, not from start).
  const stats = computeStats([{ pnl: 200 }, { pnl: -100 }], 1000)
  assert.ok(Math.abs(stats.maxDrawdownPct - (100 / 1200) * 100) < 1e-9)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test bridge/backtest.test.mjs`
Expected: FAIL — `computeStats` is not exported yet.

- [ ] **Step 3: Write the implementation**

Append to `bridge/backtest.mjs`:

```js
/**
 * Summary performance stats from a completed trade list. Drawdown is
 * tracked against the running peak balance, not the starting balance — a
 * strategy that goes up 20% then down 10% has a 10%-of-peak drawdown, not a
 * misleading "still up overall" figure.
 */
export function computeStats(trades, startingBalance = 10000) {
  let balance = startingBalance
  let peak = startingBalance
  let maxDrawdown = 0
  let wins = 0

  for (const t of trades) {
    balance += t.pnl
    if (balance > peak) peak = balance
    const drawdown = (peak - balance) / peak
    if (drawdown > maxDrawdown) maxDrawdown = drawdown
    if (t.pnl > 0) wins++
  }

  return {
    tradeCount: trades.length,
    totalReturnPct: ((balance - startingBalance) / startingBalance) * 100,
    winRatePct: trades.length ? (wins / trades.length) * 100 : 0,
    maxDrawdownPct: maxDrawdown * 100,
    endingBalance: balance,
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test bridge/backtest.test.mjs`
Expected: PASS, all tests in the file green.

- [ ] **Step 5: Commit**

```bash
git add bridge/backtest.mjs bridge/backtest.test.mjs
git commit -m "backtest: compute return/win-rate/drawdown stats"
```

---

### Task 4: The `backtest_run` MCP tool

**Files:**
- Modify: `bridge/backtest.mjs`

- [ ] **Step 1: Write the implementation**

No new unit test for this step — it orchestrates the already-tested pure functions plus one network call, the same shape as `forex.mjs`'s `initForex`. Append to `bridge/backtest.mjs`:

```js
const PAIR_RE = /^[A-Z]{3}_[A-Z]{3}$/

function formatTrade(t, i) {
  return (
    `${i + 1}. ${t.entryTime.slice(0, 10)} @ ${t.entryPrice.toFixed(5)} -> ` +
    `${t.exitTime.slice(0, 10)} @ ${t.exitPrice.toFixed(5)} ` +
    `(P&L ${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(5)})`
  )
}

const ok = (text) => ({ content: [{ type: 'text', text }] })
const refuse = (text) => ({ isError: true, content: [{ type: 'text', text }] })

export function backtestServer() {
  return createSdkMcpServer({
    name: 'jarvis_backtest',
    version: '1.0.0',
    instructions:
      'Backtest a moving-average-crossover strategy against a year of OANDA ' +
      'daily history. Returns stats and a trade list as plain text — put the ' +
      'substance on a blade using your own hud-* markup, the same way you ' +
      'would for any other data tool.',
    tools: [
      tool(
        'backtest_run',
        'Backtest a moving-average-crossover strategy on a forex pair using ' +
          'historical OANDA daily candles. Reports total return, win rate, ' +
          'max drawdown, trade count, and the individual trades.',
        {
          pair: z.string().describe('Instrument name, e.g. EUR_USD, GBP_USD'),
          fast_period: z.number().optional().describe('Fast moving-average period in days, default 10'),
          slow_period: z.number().optional().describe('Slow moving-average period in days, default 30'),
          count: z.number().optional().describe('Number of daily candles to fetch, default 252 (about one year)'),
        },
        async (args) => {
          const apiKey = process.env.JARVIS_OANDA_API_KEY
          const accountId = process.env.JARVIS_OANDA_ACCOUNT_ID
          if (!apiKey || !accountId) {
            return refuse(
              'Forex backtesting is not configured — set JARVIS_OANDA_API_KEY ' +
                'and JARVIS_OANDA_ACCOUNT_ID to enable it.',
            )
          }

          let env
          try {
            env = resolveEnv()
          } catch (err) {
            return refuse(`Forex backtesting is not configured — ${err.message}`)
          }

          const pair = String(args.pair ?? '').trim().toUpperCase()
          if (!PAIR_RE.test(pair)) {
            return refuse(`"${pair}" isn't a valid instrument name, e.g. EUR_USD.`)
          }

          const count = Math.min(5000, Math.max(30, Math.round(Number(args.count) || 252)))

          let candles
          try {
            candles = await fetchCandlesOnce({ host: hostFor(env), accountId, apiKey, pair, count })
          } catch (err) {
            return refuse(`Could not fetch historical data for ${pair}: ${err.message}`)
          }
          if (!candles.length) {
            return ok(`No historical data available for ${pair}.`)
          }

          const fastPeriod = Math.max(2, Math.round(Number(args.fast_period) || 10))
          const slowPeriod = Math.max(fastPeriod + 1, Math.round(Number(args.slow_period) || 30))
          const trades = movingAverageCrossoverStrategy(candles, { fastPeriod, slowPeriod })

          if (!trades.length) {
            return ok(
              `Backtested ${pair} over ${candles.length} daily candles ` +
                `(${fastPeriod}/${slowPeriod}-day MA crossover): 0 trades — ` +
                `no crossovers occurred in this window.`,
            )
          }

          const stats = computeStats(trades)
          return ok(
            `Backtested ${pair} over ${candles.length} daily candles ` +
              `(${fastPeriod}/${slowPeriod}-day MA crossover):\n` +
              `Trades: ${stats.tradeCount}\n` +
              `Win rate: ${stats.winRatePct.toFixed(1)}%\n` +
              `Total return: ${stats.totalReturnPct.toFixed(2)}%\n` +
              `Max drawdown: ${stats.maxDrawdownPct.toFixed(2)}%\n\n` +
              `Trades:\n${trades.map(formatTrade).join('\n')}`,
          )
        },
      ),
    ],
  })
}
```

- [ ] **Step 2: Verify it loads without error**

Run: `node --check bridge/backtest.mjs`
Expected: no output (valid syntax).

Run: `node --test bridge/backtest.test.mjs`
Expected: PASS — confirms the new code didn't break the existing pure-function tests (importing `createSdkMcpServer`/`tool`/`z` and `resolveEnv`/`hostFor` at the top of the file must not throw at import time).

- [ ] **Step 3: Commit**

```bash
git add bridge/backtest.mjs
git commit -m "backtest: add the backtest_run MCP tool"
```

---

### Task 5: Wire into server.mjs

**Files:**
- Modify: `bridge/server.mjs`

- [ ] **Step 1: Import the new module**

At the top of `bridge/server.mjs`, alongside the other bridge module imports:

```js
import { forexServer, forexRoute, initForex } from './forex.mjs'
import { backtestServer } from './backtest.mjs'
```

- [ ] **Step 2: Register the MCP server**

Inside the `mcpServers` object passed to `query()`, add the backtest server next to `jarvis_forex`:

```js
        jarvis_forex: forexServer(),
        jarvis_backtest: backtestServer(),
```

- [ ] **Step 3: Allow the tool in `decideTool`**

`backtest_run` fetches historical data and runs a simulation — no OANDA account state is ever written, and the tool name doesn't start with a read verb (`run`) and isn't caught by `EFFECTFUL_VERB` either, so without an explicit rule it would fall through to `ALLOW_WRITES`, which is wrong for something this read-only. Add it next to the `jarvis_forex` case inside `decideTool`:

```js
    if (server === 'jarvis_forex') return true

    // Read-only: fetches historical data and simulates a strategy against
    // it. No account state is ever written.
    if (server === 'jarvis_backtest') return true
```

- [ ] **Step 4: Verify**

Run: `node --check bridge/server.mjs`
Expected: no output.

Run: `node --test bridge/**/*.test.mjs`
Expected: all existing tests (phase 1's forex tests plus this phase's backtest tests) pass.

- [ ] **Step 5: Commit**

```bash
git add bridge/server.mjs
git commit -m "backtest: wire the backtest_run tool into the bridge"
```

---

### Task 6: CLI script and npm script

**Files:**
- Create: `scripts/backtest.mjs`
- Modify: `package.json`
- Modify: `README.md`

- [ ] **Step 1: Write the CLI script**

Create `scripts/backtest.mjs`:

```js
#!/usr/bin/env node
/**
 * Run a backtest from the command line, independent of JARVIS/voice.
 *
 *   node scripts/backtest.mjs EUR_USD [fastPeriod] [slowPeriod] [count]
 *
 * Shares its engine (candle fetch, strategy, stats) with the backtest_run
 * MCP tool in bridge/backtest.mjs — there is exactly one implementation of
 * the actual backtesting logic.
 */

import { fetchCandlesOnce, movingAverageCrossoverStrategy, computeStats } from '../bridge/backtest.mjs'
import { resolveEnv, hostFor } from '../bridge/forex.mjs'

const [, , pairArg, fastArg, slowArg, countArg] = process.argv
const pair = (pairArg ?? 'EUR_USD').toUpperCase()
const fastPeriod = Number(fastArg) || 10
const slowPeriod = Number(slowArg) || 30
const count = Number(countArg) || 252

const apiKey = process.env.JARVIS_OANDA_API_KEY
const accountId = process.env.JARVIS_OANDA_ACCOUNT_ID
if (!apiKey || !accountId) {
  console.error('Set JARVIS_OANDA_API_KEY and JARVIS_OANDA_ACCOUNT_ID to run a backtest.')
  process.exit(1)
}

const env = resolveEnv()
const candles = await fetchCandlesOnce({ host: hostFor(env), accountId, apiKey, pair, count })
if (!candles.length) {
  console.error(`No historical data for ${pair}.`)
  process.exit(1)
}

const trades = movingAverageCrossoverStrategy(candles, { fastPeriod, slowPeriod })
const stats = computeStats(trades)

console.log(`${pair} — ${candles.length} daily candles, ${fastPeriod}/${slowPeriod}-day MA crossover`)
console.log(`Trades: ${stats.tradeCount}`)
console.log(`Win rate: ${stats.winRatePct.toFixed(1)}%`)
console.log(`Total return: ${stats.totalReturnPct.toFixed(2)}%`)
console.log(`Max drawdown: ${stats.maxDrawdownPct.toFixed(2)}%`)
for (const t of trades) {
  console.log(
    `  ${t.entryTime.slice(0, 10)} @ ${t.entryPrice.toFixed(5)} -> ` +
      `${t.exitTime.slice(0, 10)} @ ${t.exitPrice.toFixed(5)} ` +
      `(P&L ${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(5)})`,
  )
}
```

- [ ] **Step 2: Add the npm script**

In `package.json`, add to `"scripts"`:

```json
    "backtest": "node scripts/backtest.mjs",
```

- [ ] **Step 3: Verify**

Run: `node --check scripts/backtest.mjs`
Expected: no output.

If you have OANDA credentials available:

```bash
JARVIS_OANDA_API_KEY=<key> JARVIS_OANDA_ACCOUNT_ID=<id> npm run backtest -- EUR_USD
```

Expected: prints a stats summary and trade list, matching the same numbers the MCP tool would report for the same inputs (they share the exact same engine functions).

- [ ] **Step 4: Document it in the README**

In `README.md`, find the existing `### Bridge` config table (where `JARVIS_OANDA_*` and `JARVIS_FOREX_*` vars from phase 1/2 are documented) and add a short paragraph after it:

```markdown
### Backtesting

Test a moving-average-crossover strategy against a year of OANDA daily
history, either by voice ("backtest EUR/USD") or from the command line:

```bash
npm run backtest -- EUR_USD          # defaults: 10/30-day MA, 252 candles
npm run backtest -- GBP_USD 5 20 500 # fastPeriod slowPeriod count
```

Needs the same `JARVIS_OANDA_API_KEY`/`JARVIS_OANDA_ACCOUNT_ID` as the forex
feed. Results are not saved anywhere — each run is independent.
```

- [ ] **Step 5: Commit**

```bash
git add scripts/backtest.mjs package.json README.md
git commit -m "backtest: add the CLI script and document it"
```

---

## Self-Review Notes

- **Spec coverage:** candle fetching/parsing → Task 1. Strategy (long-only, one position, buy/sell on crossover) → Task 2, including the "unclosed position isn't a trade" rule the spec implies but doesn't spell out explicitly (added as an explicit test since it's an easy edge case to get wrong). Stats (return/win-rate/drawdown/count) → Task 3, including drawdown-from-peak (not from start) which the spec's wording ("largest peak-to-trough decline") requires and Task 3 has a dedicated test for. MCP tool returning plain text, no HTML → Task 4. CLI script sharing the engine → Task 6. Error handling (missing config, no candles, zero trades) → Task 4, mirrored in the CLI's simpler form in Task 6. Endpoint verification open item → Task 1, Step 1.
- **No placeholders:** every step has complete, runnable code.
- **Type/name consistency check:** `parseCandles`, `fetchCandlesOnce`, `movingAverageCrossoverStrategy`, `computeStats`, `backtestServer` are used with identical names/signatures across `backtest.mjs`, `server.mjs`, and `scripts/backtest.mjs`. The `Trade` shape (`entryTime`, `entryPrice`, `exitTime`, `exitPrice`, `pnl`) is produced once (Task 2) and consumed identically by `computeStats` (Task 3), the MCP tool's `formatTrade` (Task 4), and the CLI script (Task 6).
