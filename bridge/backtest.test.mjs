import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCandles, movingAverageCrossoverStrategy, computeStats, scaleTradesToNotional } from './backtest.mjs'

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

test('parseCandles drops a candle missing its mid prices rather than throwing', () => {
  const json = { candles: [{ time: 't1', complete: true }] } // no `mid` field
  assert.deepEqual(parseCandles(json), [])
})

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

test('scaleTradesToNotional converts price-delta pnl into a currency amount', () => {
  const scaled = scaleTradesToNotional([{ pnl: 0.002 }], 10000)
  assert.ok(Math.abs(scaled[0].pnl - 20) < 1e-9)
})

test('scaleTradesToNotional preserves every other field on the trade', () => {
  const trade = { entryTime: 't1', entryPrice: 1.1, exitTime: 't2', exitPrice: 1.102, pnl: 0.002 }
  const [scaled] = scaleTradesToNotional([trade], 10000)
  assert.equal(scaled.entryTime, 't1')
  assert.equal(scaled.entryPrice, 1.1)
  assert.equal(scaled.exitTime, 't2')
  assert.equal(scaled.exitPrice, 1.102)
})

test('a realistic forex-scale backtest produces a non-zero, correctly-scaled total return', () => {
  // A modest 20-pip move (0.002) on a 10,000-unit notional is $20 on a
  // $10,000 starting balance — 0.2%, not the ~0.00002% a raw price-delta
  // pnl fed straight into computeStats would produce.
  const scaled = scaleTradesToNotional([{ pnl: 0.002 }], 10000)
  const stats = computeStats(scaled, 10000)
  assert.ok(Math.abs(stats.totalReturnPct - 0.2) < 1e-6)
})
