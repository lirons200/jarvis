import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseOrderResponse, formatStopPrice, buildClientOrderId, aggregateStopLossStatus, parseCloseResponse } from './trading-orders.mjs'

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

test('parseOrderResponse treats an ambiguous response (fill + reject) as not filled', () => {
  const json = {
    orderFillTransaction: { price: '1.1', tradeOpened: { tradeID: '1' } },
    orderRejectTransaction: { rejectReason: 'SOMETHING' },
  }
  const result = parseOrderResponse(json)
  assert.equal(result.filled, false)
  assert.match(result.reason, /ambiguous/)
})

test('formatStopPrice throws on a non-finite price', () => {
  assert.throws(() => formatStopPrice(NaN, 5))
  assert.throws(() => formatStopPrice(Infinity, 5))
})

test('buildClientOrderId is deterministic for the same pair and signal date', () => {
  const a = buildClientOrderId('EUR_USD', '2026-01-04T00:00:00Z')
  const b = buildClientOrderId('EUR_USD', '2026-01-04T00:00:00Z')
  assert.equal(a, b)
  const c = buildClientOrderId('GBP_USD', '2026-01-04T00:00:00Z')
  assert.notEqual(a, c)
})

test('aggregateStopLossStatus reports a single protected trade as protected', () => {
  const tradesJson = { trades: [{ id: 't1', instrument: 'EUR_USD' }] }
  const ordersJson = { orders: [{ type: 'STOP_LOSS', tradeID: 't1' }] }
  const result = aggregateStopLossStatus(tradesJson, ordersJson)
  assert.equal(result.EUR_USD.hasStopLoss, true)
  assert.equal(result.EUR_USD.tradeId, 't1')
})

test('aggregateStopLossStatus reports a single unprotected trade as unprotected', () => {
  const tradesJson = { trades: [{ id: 't1', instrument: 'EUR_USD' }] }
  const ordersJson = { orders: [] }
  const result = aggregateStopLossStatus(tradesJson, ordersJson)
  assert.equal(result.EUR_USD.hasStopLoss, false)
})

test('aggregateStopLossStatus reports an instrument as unprotected if ANY of its trades lacks a stop-loss', () => {
  const tradesJson = {
    trades: [
      { id: 't1', instrument: 'EUR_USD' },
      { id: 't2', instrument: 'EUR_USD' },
    ],
  }
  const ordersJson = { orders: [{ type: 'STOP_LOSS', tradeID: 't1' }] } // only t1 is protected
  const result = aggregateStopLossStatus(tradesJson, ordersJson)
  assert.equal(result.EUR_USD.hasStopLoss, false)
})

test('aggregateStopLossStatus reports an instrument as protected only if ALL of its trades have a stop-loss', () => {
  const tradesJson = {
    trades: [
      { id: 't1', instrument: 'EUR_USD' },
      { id: 't2', instrument: 'EUR_USD' },
    ],
  }
  const ordersJson = {
    orders: [
      { type: 'STOP_LOSS', tradeID: 't1' },
      { type: 'STOP_LOSS', tradeID: 't2' },
    ],
  }
  const result = aggregateStopLossStatus(tradesJson, ordersJson)
  assert.equal(result.EUR_USD.hasStopLoss, true)
})

test('aggregateStopLossStatus ignores non-STOP_LOSS pending orders', () => {
  const tradesJson = { trades: [{ id: 't1', instrument: 'EUR_USD' }] }
  const ordersJson = { orders: [{ type: 'TAKE_PROFIT', tradeID: 't1' }] }
  const result = aggregateStopLossStatus(tradesJson, ordersJson)
  assert.equal(result.EUR_USD.hasStopLoss, false)
})

test('aggregateStopLossStatus handles multiple instruments independently', () => {
  const tradesJson = {
    trades: [
      { id: 't1', instrument: 'EUR_USD' },
      { id: 't2', instrument: 'GBP_USD' },
    ],
  }
  const ordersJson = { orders: [{ type: 'STOP_LOSS', tradeID: 't1' }] }
  const result = aggregateStopLossStatus(tradesJson, ordersJson)
  assert.equal(result.EUR_USD.hasStopLoss, true)
  assert.equal(result.GBP_USD.hasStopLoss, false)
})

test('aggregateStopLossStatus tolerates missing trades/orders arrays', () => {
  assert.deepEqual(aggregateStopLossStatus({}, {}), {})
  assert.deepEqual(aggregateStopLossStatus(null, null), {})
})

test('parseCloseResponse reports a confirmed close from longOrderFillTransaction', () => {
  const json = { longOrderFillTransaction: { id: '2468', type: 'ORDER_FILL' } }
  assert.deepEqual(parseCloseResponse(json), { closed: true })
})

test('parseCloseResponse reports an unconfirmed close from longOrderCancelTransaction', () => {
  const json = { longOrderCancelTransaction: { reason: 'MARKET_HALTED' } }
  const result = parseCloseResponse(json)
  assert.equal(result.closed, false)
  assert.equal(result.reason, 'MARKET_HALTED')
})

test('parseCloseResponse reports an unconfirmed close from an error response', () => {
  const json = { errorMessage: 'Position not found' }
  const result = parseCloseResponse(json)
  assert.equal(result.closed, false)
  assert.equal(result.reason, 'Position not found')
})

test('parseCloseResponse treats an unrecognised shape as unconfirmed rather than throwing', () => {
  const result = parseCloseResponse({})
  assert.equal(result.closed, false)
  assert.equal(result.reason, 'unknown response shape')
})
