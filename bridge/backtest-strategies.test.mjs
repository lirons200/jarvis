import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  movingAverageCrossoverStrategy,
  scaleTradesToNotional,
  scaleTradesToUsd,
  rateAtTime,
  needsConversionRates,
  fetchUsdRateSeries,
  rsiSeries,
  rsiMeanReversionStrategy,
  donchianBreakoutStrategy,
  resolveStrategy,
  executeBacktest,
  formatReport,
} from './backtest.mjs'

// ---------------------------------------------------------------------------
// USD conversion — hand-calculated (10,000-unit notional, USD account)
// ---------------------------------------------------------------------------

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`)
const trade = (entryPrice, exitPrice, exitTime = '2026-03-10T00:00:00Z') => ({
  entryTime: '2026-03-01T00:00:00Z', entryPrice, exitTime, exitPrice, pnl: exitPrice - entryPrice,
})

test('EUR_USD (quote USD): factor 1 — 0.0020 * 10000 = 20 USD', () => {
  const r = scaleTradesToUsd([trade(1.1, 1.102)], 'EUR_USD')
  assert.equal(r.converted, true)
  assert.equal(r.currency, 'USD')
  close(r.trades[0].pnl, 20)
})

test('USD_JPY: 150.00 -> 151.00 is 10,000 JPY, / 151 exit = 66.2251655... USD', () => {
  const r = scaleTradesToUsd([trade(150, 151)], 'USD_JPY')
  assert.equal(r.converted, true)
  close(r.trades[0].pnl, 66.2251655629, 1e-9)
})

test('USD_JPY loss: 150 -> 148 is -20,000 JPY = -135.135135... USD (exit 148)', () => {
  const r = scaleTradesToUsd([trade(150, 148)], 'USD_JPY')
  close(r.trades[0].pnl, -20000 / 148)
  close(r.trades[0].pnl, -135.135135135, 1e-6)
})

test('EUR_GBP cross: +0.01 * 10000 = 100 GBP, GBP_USD 1.25 at exit => 125 USD', () => {
  const series = [
    { time: '2026-03-09T00:00:00Z', usdPerQuote: 1.25 },
    { time: '2026-03-11T00:00:00Z', usdPerQuote: 9 }, // after exit: must be ignored
  ]
  const r = scaleTradesToUsd([trade(0.85, 0.86)], 'EUR_GBP', { rateSeries: series })
  assert.equal(r.converted, true)
  close(r.trades[0].pnl, 125)
})

test('cross pair without a rate series is NOT silently converted; warning names the currency', () => {
  const r = scaleTradesToUsd([trade(0.85, 0.86)], 'EUR_GBP')
  assert.equal(r.converted, false)
  assert.equal(r.currency, 'GBP')
  assert.match(r.warning, /GBP.*NOT converted to USD/)
  close(r.trades[0].pnl, 100) // left in GBP
})

test('cross pair whose rate series starts after the exit is unconverted for the whole list (no mixed currencies)', () => {
  const series = [{ time: '2026-03-12T00:00:00Z', usdPerQuote: 1.25 }]
  const r = scaleTradesToUsd([trade(0.85, 0.86)], 'EUR_GBP', { rateSeries: series })
  assert.equal(r.converted, false)
  assert.match(r.warning, /on or before/)
})

test('rateAtTime returns the latest rate at or before the time, never a later one', () => {
  const s = [
    { time: '2026-03-01T00:00:00Z', usdPerQuote: 1 },
    { time: '2026-03-05T00:00:00Z', usdPerQuote: 2 },
    { time: '2026-03-09T00:00:00Z', usdPerQuote: 3 },
  ]
  assert.equal(rateAtTime(s, '2026-03-05T00:00:00Z'), 2)
  assert.equal(rateAtTime(s, '2026-03-08T12:00:00Z'), 2)
  assert.equal(rateAtTime(s, '2026-02-28T00:00:00Z'), null)
  assert.equal(rateAtTime(null, '2026-03-05T00:00:00Z'), null)
})

test('needsConversionRates: only crosses', () => {
  assert.equal(needsConversionRates('EUR_USD'), false)
  assert.equal(needsConversionRates('USD_JPY'), false)
  assert.equal(needsConversionRates('EUR_GBP'), true)
})

test('fetchUsdRateSeries uses Q_USD directly, or inverts USD_Q, and returns null when neither exists', async () => {
  const calls = []
  const direct = async ({ pair }) => {
    calls.push(pair)
    return [{ time: 't', close: 1.25 }]
  }
  assert.deepEqual(await fetchUsdRateSeries({ quote: 'GBP' }, direct), [{ time: 't', usdPerQuote: 1.25 }])
  assert.deepEqual(calls, ['GBP_USD'])

  const inverseOnly = async ({ pair }) => {
    if (pair === 'ZAR_USD') throw new Error('400')
    return [{ time: 't', close: 20 }] // USD_ZAR = 20 => 0.05 USD per ZAR
  }
  close((await fetchUsdRateSeries({ quote: 'ZAR' }, inverseOnly))[0].usdPerQuote, 0.05)

  const none = async () => { throw new Error('nope') }
  assert.equal(await fetchUsdRateSeries({ quote: 'XXX' }, none), null)
})

// ---------------------------------------------------------------------------
// RSI (Wilder) — hand-calculated
// ---------------------------------------------------------------------------

test('rsiSeries period 2, [10,11,10,12]: seed 50, then Wilder smoothing gives 83.333', () => {
  // changes +1,-1: avgGain=.5 avgLoss=.5 -> RSI 50.
  // next +2: avgGain=(.5*1+2)/2=1.25 avgLoss=(.5*1+0)/2=.25 -> RS 5 -> 100-100/6
  const r = rsiSeries([10, 11, 10, 12], 2)
  assert.equal(r[0], null)
  assert.equal(r[1], null)
  close(r[2], 50)
  close(r[3], 100 - 100 / 6)
})

test('rsiSeries matches the published Wilder/StockCharts 14-period first value (70.53)', () => {
  const closes = [44.3389, 44.0902, 44.1497, 43.6124, 44.3278, 44.8264, 45.0955, 45.4245, 45.8433,
    46.0826, 45.8931, 46.0328, 45.6140, 46.2820, 46.2820]
  const r = rsiSeries(closes, 14)
  assert.ok(Math.abs(r[14] - 70.53) < 0.05, `got ${r[14]}`)
})

test('rsiSeries edge cases: all gains -> 100, flat -> 50, too-short input -> all null', () => {
  close(rsiSeries([1, 2, 3, 4], 3)[3], 100)
  close(rsiSeries([5, 5, 5, 5], 3)[3], 50)
  assert.deepEqual(rsiSeries([1, 2], 3), [null, null])
})

const mk = (rows) => rows.map(([c, high, low], i) => ({
  time: `2026-04-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
  open: c, high: high ?? c, low: low ?? c, close: c,
}))

test('rsiMeanReversionStrategy: buys when RSI<oversold, sells when RSI>exit (hand-worked)', () => {
  // closes 10,9,8,7,9 period 2: RSI[2]=0 (buy @8), RSI[3]=0 (already long),
  // idx4: avgGain=(0+2)/2=1, avgLoss=(1*1+0)/2=.5 -> RSI 66.67 > 50 (sell @9)
  const trades = rsiMeanReversionStrategy(mk([[10], [9], [8], [7], [9]]), { period: 2, oversold: 30, exitLevel: 50 })
  assert.equal(trades.length, 1)
  assert.equal(trades[0].entryPrice, 8)
  assert.equal(trades[0].exitPrice, 9)
  assert.equal(trades[0].pnl, 1)
  assert.deepEqual(Object.keys(trades[0]).sort(), ['entryPrice', 'entryTime', 'exitPrice', 'exitTime', 'pnl'])
})

test('rsiMeanReversionStrategy drops an unclosed position and trades nothing on flat data', () => {
  assert.deepEqual(rsiMeanReversionStrategy(mk([[10], [9], [8], [7]]), { period: 2 }), [])
  assert.deepEqual(rsiMeanReversionStrategy(mk([[10], [10], [10], [10]]), { period: 2 }), [])
})

// ---------------------------------------------------------------------------
// Donchian — hand-calculated; channel excludes the current bar
// ---------------------------------------------------------------------------

test('donchianBreakoutStrategy enters above prior-N high and exits below prior-M low', () => {
  // high=close+1, low=close-1. entryPeriod 3, exitPeriod 2.
  // i=4: prior 3 highs (i1..3) = 11; close 15 > 11 -> buy @15.
  // i=5: close 16 vs lowest low of i3,i4 = min(9,14)=9 -> hold.
  // i=6: close 12 < lowest low of i4,i5 = min(14,15)=14 -> sell @12. pnl -3.
  const rows = [10, 10, 10, 10, 15, 16, 12].map((c) => [c, c + 1, c - 1])
  const trades = donchianBreakoutStrategy(mk(rows), { entryPeriod: 3, exitPeriod: 2 })
  assert.equal(trades.length, 1)
  assert.equal(trades[0].entryPrice, 15)
  assert.equal(trades[0].exitPrice, 12)
  assert.equal(trades[0].pnl, -3)
  assert.equal(trades[0].entryTime, '2026-04-05T00:00:00Z')
})

test("donchianBreakoutStrategy: a spike in the current bar's HIGH alone does not trigger; close must beat prior highs", () => {
  const rows = [[10, 11, 9], [10, 11, 9], [10, 11, 9], [10.5, 50, 9]]
  assert.deepEqual(donchianBreakoutStrategy(mk(rows), { entryPeriod: 3, exitPeriod: 2 }), [])
})

test('donchianBreakoutStrategy needs a full prior window (no signal before index entryPeriod)', () => {
  const rows = [[10, 11, 9], [20, 21, 19]]
  assert.deepEqual(donchianBreakoutStrategy(mk(rows), { entryPeriod: 3, exitPeriod: 2 }), [])
})

// ---------------------------------------------------------------------------
// Registry / validation
// ---------------------------------------------------------------------------

test('resolveStrategy defaults to ma_crossover with legacy params', () => {
  const r = resolveStrategy(undefined, {})
  assert.equal(r.name, 'ma_crossover')
  assert.deepEqual(r.params, { fastPeriod: 10, slowPeriod: 30 })
  assert.deepEqual(resolveStrategy('ma_crossover', { fast_period: 5, slow_period: 5 }).params, { fastPeriod: 5, slowPeriod: 6 })
})

test('resolveStrategy rejects unknown strategy, foreign params, out-of-range, non-integer and inverted thresholds', () => {
  assert.throws(() => resolveStrategy('macd'), /Unknown strategy "macd".*ma_crossover/)
  assert.throws(() => resolveStrategy('__proto__'), /Unknown strategy/)
  assert.throws(() => resolveStrategy('rsi_mean_reversion', { fast_period: 5 }), /does not apply/)
  assert.throws(() => resolveStrategy('ma_crossover', { rsi_period: 5 }), /does not apply/)
  assert.throws(() => resolveStrategy('ma_crossover', { bogus: 5 }), /Unknown parameter/)
  assert.throws(() => resolveStrategy('rsi_mean_reversion', { rsi_period: 1 }), /between 2 and 100/)
  assert.throws(() => resolveStrategy('rsi_mean_reversion', { rsi_period: 101 }), /between 2 and 100/)
  assert.throws(() => resolveStrategy('rsi_mean_reversion', { rsi_period: 14.5 }), /whole number/)
  assert.throws(() => resolveStrategy('rsi_mean_reversion', { rsi_period: 'abc' }), /whole number/)
  assert.throws(() => resolveStrategy('rsi_mean_reversion', { oversold: 60 }), /oversold must be between/)
  assert.throws(() => resolveStrategy('rsi_mean_reversion', { oversold: 40, exit_level: 40 }), /greater than oversold/)
  assert.throws(() => resolveStrategy('donchian_breakout', { entry_period: 1 }), /entry_period must be between/)
  assert.throws(() => resolveStrategy('donchian_breakout', { exit_period: 201 }), /exit_period must be between/)
})

test('resolveStrategy accepts valid per-strategy params, incl. CLI-style strings', () => {
  assert.deepEqual(resolveStrategy('rsi_mean_reversion', { rsi_period: '7', oversold: 25, exit_level: 55 }).params,
    { period: 7, oversold: 25, exitLevel: 55 })
  assert.deepEqual(resolveStrategy('donchian_breakout', { entry_period: 55 }).params, { entryPeriod: 55, exitPeriod: 10 })
})

// ---------------------------------------------------------------------------
// executeBacktest — injected fetch, no network
// ---------------------------------------------------------------------------

test('executeBacktest validates before fetching (bad params never hit the network)', async () => {
  let fetched = 0
  const res = await executeBacktest(
    { pair: 'EUR_USD', strategy: 'rsi_mean_reversion', params: { rsi_period: 0 } },
    async () => { fetched++; return [] },
  )
  assert.equal(res.kind, 'error')
  assert.match(res.text, /rsi_period/)
  assert.equal(fetched, 0)
})

test('executeBacktest USD_JPY end-to-end converts P&L to USD and reports it', async () => {
  // 150,149,148,147,149 with RSI period 2 -> buy @148 (idx2), sell @149 (idx4)
  const fake = async () => mk([150, 149, 148, 147, 149].map((c) => [c]))
  const res = await executeBacktest({ pair: 'USD_JPY', strategy: 'rsi_mean_reversion', params: { rsi_period: 2 }, count: 50 }, fake)
  assert.equal(res.kind, 'ok')
  assert.equal(res.currency, 'USD')
  close(res.trades[0].pnl, 10000 / 149) // +1 JPY * 10000 units / 149
  assert.match(formatReport(res), /P&L currency: USD/)
})

test('executeBacktest cross pair with unavailable conversion rate states it explicitly', async () => {
  const fake = async ({ pair }) => {
    if (pair === 'EUR_GBP') return mk([0.9, 0.89, 0.88, 0.87, 0.89].map((c) => [c]))
    throw new Error('no such instrument')
  }
  const res = await executeBacktest({ pair: 'EUR_GBP', strategy: 'rsi_mean_reversion', params: { rsi_period: 2 } }, fake)
  assert.equal(res.kind, 'ok')
  assert.equal(res.converted, false)
  const text = formatReport(res)
  assert.match(text, /WARNING: P&L is in GBP, NOT converted to USD/)
  assert.doesNotMatch(text, /Total return/)
})

test('executeBacktest default strategy reproduces the MA crossover trades exactly', async () => {
  const candles = mk([10, 10, 10, 12, 14, 16, 10, 8, 6].map((c) => [c]))
  const res = await executeBacktest({ pair: 'EUR_USD', params: { fast_period: 2, slow_period: 3 } }, async () => candles)
  const direct = scaleTradesToNotional(movingAverageCrossoverStrategy(candles, { fastPeriod: 2, slowPeriod: 3 }))
  assert.deepEqual(res.trades, direct)
})
