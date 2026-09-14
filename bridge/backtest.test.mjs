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
