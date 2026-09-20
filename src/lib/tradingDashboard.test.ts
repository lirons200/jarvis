import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  tradingState, formatPnl, lossBudgetUsed, openPositions, hasUnprotectedPosition,
  recentJournal, formatJournalLine, parseTradingSnapshot, isSnapshotStale, FIXTURE_TRADING_SNAPSHOT,
} from './tradingDashboard'

const fx = FIXTURE_TRADING_SNAPSHOT
if (!fx.enabled) throw new Error('fixture must be enabled')

test('formatPnl signs values and renders unknown as a dash, not zero', () => {
  assert.equal(formatPnl(3.456), '+3.46')
  assert.equal(formatPnl(-12.4), '-12.40')
  assert.equal(formatPnl(0), '0.00')
  assert.equal(formatPnl(null), '—')
})

test('lossBudgetUsed counts only losses, clamps to 0..1, and is null when unknown', () => {
  assert.equal(lossBudgetUsed({ realizedToday: -10, unrealized: 0, dailyLossLimit: 50 }), 0.2)
  assert.equal(lossBudgetUsed({ realizedToday: 20, unrealized: 0, dailyLossLimit: 50 }), 0)
  assert.equal(lossBudgetUsed({ realizedToday: -80, unrealized: 0, dailyLossLimit: 50 }), 1)
  assert.equal(lossBudgetUsed({ realizedToday: null, unrealized: 0, dailyLossLimit: 50 }), null)
  assert.equal(lossBudgetUsed({ realizedToday: -1, unrealized: 0, dailyLossLimit: 0 }), null)
})

test('tradingState prioritises halted over armed', () => {
  assert.equal(tradingState({ ...fx, halted: true }), 'halted')
  assert.equal(tradingState(fx), 'armed')
  assert.equal(tradingState({ ...fx, armed: false }), 'idle')
})

test('openPositions drops flat pairs; hasUnprotectedPosition flags a missing stop', () => {
  assert.deepEqual(openPositions(fx).map((p) => p.pair), ['EUR_USD', 'USD_JPY'])
  assert.equal(hasUnprotectedPosition(fx), true)
  assert.equal(hasUnprotectedPosition({ ...fx, positions: [{ pair: 'EUR_USD', units: 1, stopLoss: 'ok' }] }), false)
  assert.equal(hasUnprotectedPosition({ ...fx, positions: null }), false)
})

test('recentJournal returns newest first and caps; formatJournalLine is compact', () => {
  const r = recentJournal(fx.journal, 2)
  assert.equal(r.length, 2)
  assert.equal(r[0].pair, 'USD_JPY')
  assert.equal(formatJournalLine(r[0]), '10:15 USD/JPY enter')
})

test('parseTradingSnapshot accepts the disabled and enabled shapes and rejects junk', () => {
  assert.deepEqual(parseTradingSnapshot({ enabled: false }), { enabled: false })
  assert.equal(parseTradingSnapshot(fx)?.enabled, true)
  assert.equal(parseTradingSnapshot(null), null)
  assert.equal(parseTradingSnapshot({ enabled: true }), null)
  assert.equal(parseTradingSnapshot('x'), null)
})

test('an unknown stop-loss counts as unprotected', () => {
  assert.equal(hasUnprotectedPosition({ ...fx, positions: [{ pair: 'EUR_USD', units: 1, stopLoss: 'unknown' }] }), true)
})

test('isSnapshotStale flags snapshots older than 30s and unparseable timestamps', () => {
  const now = Date.parse('2026-01-01T00:01:00Z')
  assert.equal(isSnapshotStale('2026-01-01T00:00:45Z', now), false)
  assert.equal(isSnapshotStale('2026-01-01T00:00:29Z', now), true)
  assert.equal(isSnapshotStale('garbage', now), true)
})
