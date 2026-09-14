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

test('computeATR returns null for a non-positive or non-integer period', () => {
  const candles = Array.from({ length: 5 }, () => ({ high: 1.11, low: 1.10, close: 1.105 }))
  assert.equal(computeATR(candles, 0), null)
  assert.equal(computeATR(candles, -3), null)
  assert.equal(computeATR(candles, 2.5), null)
})

test('computeATR returns null rather than NaN when a candle is missing high/low/close', () => {
  const candles = [
    { high: 1.11, low: 1.10, close: 1.105 },
    { high: 1.11, low: 1.10, close: 1.105 },
    {}, // malformed — missing all fields
  ]
  const result = computeATR(candles, 3)
  assert.equal(result, null)
})
