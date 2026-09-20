import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTradingSnapshot, sanitizeJournalEntry, deriveStopLossStatus } from './trading-snapshot.mjs'
import { getTradingSnapshot } from './trading.mjs'

const base = {
  armed: true, halted: false, haltReason: null,
  pairs: ['EUR_USD', 'GBP_USD'],
  openPositions: { EUR_USD: { longUnits: 1000, shortUnits: 0 } },
  liveStopLoss: { EUR_USD: { tradeId: '1', hasStopLoss: true } },
  dailyRealizedPL: -5, unrealizedPL: 2, maxDailyLoss: 50,
  journal: [], nowMs: 0,
}

test('snapshot reports per-pair units and stop-loss only for open positions', () => {
  const s = buildTradingSnapshot(base)
  assert.deepEqual(s.positions, [
    { pair: 'EUR_USD', units: 1000, stopLoss: 'ok' },
    { pair: 'GBP_USD', units: 0, stopLoss: null },
  ])
  assert.equal(s.pnl.dailyLossLimit, 50)
  assert.equal(s.at, '1970-01-01T00:00:00.000Z')
})

test('stop-loss flag comes from the live check: missing, unknown on failure, never ok by default', () => {
  const live = { EUR_USD: { hasStopLoss: false } }
  assert.equal(deriveStopLossStatus(1000, live, 'EUR_USD'), 'missing')
  assert.equal(deriveStopLossStatus(1000, { EUR_USD: { hasStopLoss: true } }, 'EUR_USD'), 'ok')
  assert.equal(deriveStopLossStatus(1000, null, 'EUR_USD'), 'unknown') // live call failed
  assert.equal(deriveStopLossStatus(1000, {}, 'EUR_USD'), 'unknown') // broker listed no trade
  assert.equal(deriveStopLossStatus(0, null, 'EUR_USD'), null)
  const s = buildTradingSnapshot({ ...base, liveStopLoss: null })
  assert.equal(s.positions[0].stopLoss, 'unknown')
})

test('unreachable broker yields null positions, NaN P&L yields null, and it stays JSON-safe', () => {
  const s = buildTradingSnapshot({ ...base, openPositions: null, dailyRealizedPL: NaN, unrealizedPL: null })
  assert.equal(s.positions, null)
  assert.equal(s.pnl.realizedToday, null)
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s)
})

test('haltReason only surfaces while halted', () => {
  assert.equal(buildTradingSnapshot({ ...base, haltReason: 'x' }).haltReason, null)
  assert.equal(buildTradingSnapshot({ ...base, halted: true, haltReason: 'x' }).haltReason, 'x')
})

test('journal entries are allowlisted: trade ids and raw errors never pass, account ids are scrubbed', () => {
  const e = sanitizeJournalEntry({
    at: 't', pair: 'EUR_USD', event: 'enter', tradeId: '999', error: 'boom', accountId: '101-004-1234567-001',
    reason: 'bad path /accounts/101-004-1234567-001/orders',
  })
  assert.equal(e.tradeId, undefined)
  assert.equal(e.error, undefined)
  assert.equal(e.accountId, undefined)
  assert.ok(!JSON.stringify(e).includes('1234567'))
})

test('getTradingSnapshot returns {enabled:false} when trading was never armed', async () => {
  assert.deepEqual(await getTradingSnapshot(), { enabled: false })
})

test('a hedged long+short position is reported as open gross exposure, not hidden as zero', () => {
  const s = buildTradingSnapshot({
    ...base,
    openPositions: { EUR_USD: { longUnits: 1000, shortUnits: -1000 } },
    liveStopLoss: null,
  })
  assert.deepEqual(s.positions[0], { pair: 'EUR_USD', units: 2000, stopLoss: 'unknown' })
})
