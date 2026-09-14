import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectLiveSignal, detectCrossoverDirection } from './trading-signal.mjs'

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

test('detectLiveSignal throws if fastPeriod is not less than slowPeriod', () => {
  const candles = candlesFromCloses([10, 10, 10])
  assert.throws(() => detectLiveSignal(candles, null, { fastPeriod: 3, slowPeriod: 3 }))
  assert.throws(() => detectLiveSignal(candles, null, { fastPeriod: 5, slowPeriod: 3 }))
})

test('detectLiveSignal throws if the last two candles are not strictly ascending by time', () => {
  const candles = [
    { time: '2026-01-02T00:00:00Z', close: 10 },
    { time: '2026-01-01T00:00:00Z', close: 11 }, // out of order
  ]
  assert.throws(() => detectLiveSignal(candles, null, { fastPeriod: 2, slowPeriod: 3 }))
})

test('detectLiveSignal throws on duplicate timestamps in the last two candles', () => {
  const candles = [
    { time: '2026-01-01T00:00:00Z', close: 10 },
    { time: '2026-01-01T00:00:00Z', close: 11 }, // duplicate
  ]
  assert.throws(() => detectLiveSignal(candles, null, { fastPeriod: 2, slowPeriod: 3 }))
})

test('detectCrossoverDirection reports "up" on an upward crossover regardless of position', () => {
  const candles = candlesFromCloses([10, 10, 10, 12, 14, 16])
  assert.equal(detectCrossoverDirection(candles.slice(0, 4), { fastPeriod: 2, slowPeriod: 3 }), 'up')
})

test('detectCrossoverDirection reports "down" on a downward crossover regardless of position', () => {
  const candles = candlesFromCloses([10, 10, 10, 12, 14, 16, 10])
  assert.equal(detectCrossoverDirection(candles, { fastPeriod: 2, slowPeriod: 3 }), 'down')
})

test('detectCrossoverDirection reports "none" with no fresh crossover', () => {
  const candles = candlesFromCloses([10, 10, 10, 12, 14])
  assert.equal(detectCrossoverDirection(candles, { fastPeriod: 2, slowPeriod: 3 }), 'none')
})
