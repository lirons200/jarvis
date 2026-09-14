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
