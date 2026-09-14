import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCandles, movingAverageCrossoverStrategy } from './backtest.mjs'

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
