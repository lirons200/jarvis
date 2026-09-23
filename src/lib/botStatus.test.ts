import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CLIENT_STALE_MS, MISSING_GRACE_MS, isClientStale, missingPill, parseBotStatus, pill, type BotStatus } from './botStatus'

const NOW = Date.parse('2026-09-21T10:00:30Z')
const base = (over: Partial<BotStatus> = {}): BotStatus => ({
  configured: true, state: 'ok', reason: null, ageSeconds: 30, stale: false, market: 'open',
  topIssue: null, lastReachableAt: '2026-09-21T10:00:05.000Z', at: '2026-09-21T10:00:20.000Z', ...over,
})

test('parseBotStatus accepts a valid body and rejects junk', () => {
  assert.equal(parseBotStatus(base())?.state, 'ok')
  for (const bad of [null, 'x', 5, {}, { ...base(), state: 'fine' }, { ...base(), market: 'weird' }, { ...base(), at: 5 }, { ...base(), configured: 'yes' }]) {
    assert.equal(parseBotStatus(bad), null)
  }
})

test('pill is hidden when not configured', () => {
  assert.equal(pill(base({ configured: false }), NOW), null)
})

test('pill shows each state in words, never colour alone', () => {
  assert.equal(pill(base({ state: 'ok' }), NOW)?.text, 'BOT OK')
  assert.equal(pill(base({ state: 'warn', topIssue: 'trade_velocity: 5 trading days' }), NOW)?.title, 'trade_velocity: 5 trading days')
  assert.equal(pill(base({ state: 'crit' }), NOW)?.level, 'crit')
  const u = pill(base({ state: 'unknown', reason: 'unreachable (network)', lastReachableAt: null }), NOW)
  assert.equal(u?.text, 'BOT UNKNOWN')
  assert.equal(u?.title, 'unreachable (network)')
})

test('a stale bridge response is unknown, never the last good state', () => {
  const s = base({ state: 'ok', at: '2026-09-21T09:58:00.000Z' })
  assert.equal(isClientStale(s, NOW), true)
  const p = pill(s, NOW)
  assert.equal(p?.level, 'unknown')
  assert.equal(p?.text, 'BOT UNKNOWN')
  assert.equal(CLIENT_STALE_MS, 60_000)
})

test('with no status at all the pill is silent briefly, then UNKNOWN (bridge down at page load)', () => {
  const mounted = Date.parse('2026-09-21T10:00:00Z')
  assert.equal(missingPill(mounted + 1000, mounted), null)
  const p = missingPill(mounted + MISSING_GRACE_MS, mounted)
  assert.equal(p?.text, 'BOT UNKNOWN')
  assert.equal(p?.level, 'unknown')
})

test('an unknown pill title includes when the bot dashboard was last reached', () => {
  const p = pill(base({ state: 'unknown', reason: 'unreachable (network)', lastReachableAt: '2026-09-21T09:55:00.000Z' }), NOW)
  assert.match(p!.title, /unreachable \(network\).*last reached the bot dashboard 2026-09-21T09:55:00.000Z/)
})

test('an unparseable or far-future timestamp is stale', () => {
  assert.equal(isClientStale(base({ at: 'garbage' }), NOW), true)
  assert.equal(isClientStale(base({ at: '2026-09-21T11:00:00.000Z' }), NOW), true)
})
