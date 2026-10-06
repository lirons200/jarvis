import { test } from 'node:test'
import assert from 'node:assert/strict'
import { edgeView, parseBotEdge, type BotEdge } from './botEdge'

const NOW = Date.parse('2026-10-04T23:00:30Z')
const body = (over: Record<string, unknown> = {}) => ({
  configured: true, state: 'ok', reason: null, ageSeconds: 5, generatedAt: '2026-10-04T23:00:00Z', verdict: 'PROMISING', ev: 0.4536, ci95: [0.3916, 0.5172],
  backtestN: 2119, live: { n: 6, ev: 0.5, status: 'INSUFFICIENT' }, gateN: 50, backtestOnly: true, reasons: [], at: '2026-10-04T23:00:20.000Z', ...over,
})
const edge = (over: Record<string, unknown> = {}) => parseBotEdge(body(over)) as BotEdge

test('parseBotEdge accepts a valid body and rejects junk', () => {
  assert.equal(parseBotEdge(body())?.verdict, 'PROMISING')
  for (const bad of [null, 'x', 5, {}, body({ verdict: 'GREAT' }), body({ ev: '1' }), body({ ci95: [1] }), body({ live: null }), body({ backtestOnly: 'yes' }), body({ at: 5 }), body({ state: 'fine' })]) {
    assert.equal(parseBotEdge(bad), null)
  }
})

test('an unknown answer parses without a verdict', () => {
  const e = parseBotEdge(body({ state: 'unknown', reason: 'unreachable (network)', verdict: null }))
  assert.equal(e?.verdict, null)
})

test('view shows verdict, ev, ci95, live n vs gate and the backtest-only label', () => {
  const v = edgeView(edge(), NOW)!
  assert.equal(v.verdict, 'PROMISING')
  assert.equal(v.ev, '+0.454R')
  assert.equal(v.ci95, '+0.392R to +0.517R')
  assert.equal(v.live, '6 of gate 50')
  assert.equal(v.progress, 6 / 50)
  assert.match(v.honesty ?? '', /^BACKTEST-ONLY/)
})

test('no backtest-only label when live evidence is sufficient; NO_EDGE maps to its own level', () => {
  assert.equal(edgeView(edge({ backtestOnly: false, verdict: 'PROVEN' }), NOW)?.honesty, null)
  assert.equal(edgeView(edge({ verdict: 'NO_EDGE' }), NOW)?.level, 'noedge')
})

test('hidden when not configured; UNKNOWN (never a stale verdict) when unknown or the bridge answer is old', () => {
  assert.equal(edgeView(edge({ configured: false, state: 'unknown' }), NOW), null)
  const u = edgeView(edge({ state: 'unknown', reason: 'unreachable (network)', verdict: null }), NOW)!
  assert.equal(u.verdict, 'UNKNOWN')
  assert.equal(u.honesty, 'unreachable (network)')
  const old = edgeView(edge(), NOW + 120_000)!
  assert.equal(old.verdict, 'UNKNOWN')
  assert.match(old.honesty ?? '', /lost contact/)
})
