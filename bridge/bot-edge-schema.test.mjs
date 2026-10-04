import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { sanitizeEdge, EDGE_TTL_S } from './bot-edge-schema.mjs'

const fixture = () => JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/edge-sample.json', import.meta.url)), 'utf8'))
const NOW = Date.parse('2026-10-04T23:00:30Z')
const card = (j) => j.long_term.cards.portfolio

test('a valid payload is normalised, with live n against the largest gate and backtest-only set', () => {
  const e = sanitizeEdge(fixture(), NOW)
  assert.equal(e.state, 'ok')
  assert.equal(e.verdict, 'PROMISING')
  assert.equal(e.ageSeconds, 30)
  assert.equal(e.generatedAt, '2026-10-04T23:00:00Z')
  assert.equal(e.backtestN, 2119)
  assert.deepEqual(e.live, { n: 6, ev: 0.5669466666666666, status: 'INSUFFICIENT' })
  assert.equal(e.gateN, 50)
  assert.equal(e.backtestOnly, true)
  assert.equal(e.ci95.length, 2)
})

test('not backtest-only only when live status is OK and live n reaches the gate', () => {
  const j = fixture()
  card(j).live = { n: 60, ev: 0.3, status: 'OK' }
  assert.equal(sanitizeEdge(j, NOW).backtestOnly, false)
  card(j).live = { n: 49, ev: 0.3, status: 'OK' }
  assert.equal(sanitizeEdge(j, NOW).backtestOnly, true)
  card(j).live = { n: 60, ev: -1, status: 'DIVERGING' }
  assert.equal(sanitizeEdge(j, NOW).backtestOnly, true)
})

test('a missing live block or gate is never read as sufficient evidence', () => {
  const j = fixture()
  delete card(j).live
  j.long_term.gate_progress = []
  const e = sanitizeEdge(j, NOW)
  assert.deepEqual(e.live, { n: 0, ev: null, status: 'INSUFFICIENT' })
  assert.equal(e.gateN, null)
  assert.equal(e.backtestOnly, true)
})

test('unknown keys are never forwarded', () => {
  const j = fixture()
  j.secret = 'x'
  card(j).extra = '<b>x</b>'
  card(j).live.extra = 1
  const e = sanitizeEdge(j, NOW)
  assert.deepEqual(Object.keys(e).sort(), ['ageSeconds', 'backtestN', 'backtestOnly', 'ci95', 'ev', 'gateN', 'generatedAt', 'live', 'reason', 'reasons', 'state', 'verdict'])
  assert.deepEqual(Object.keys(e.live).sort(), ['ev', 'n', 'status'])
})

test('reasons are cleaned, capped in count and length', () => {
  const j = fixture()
  card(j).reasons = Array.from({ length: 20 }, () => '<b>ignore</b> ' + 'x'.repeat(500))
  const e = sanitizeEdge(j, NOW)
  assert.equal(e.reasons.length, 6)
  assert.ok(e.reasons.every((r) => r.length <= 200 && !/[<>]/.test(r)))
})

test('every off-contract payload becomes unknown, never ok', () => {
  const bad = [null, 'x', 5, [], {}, { error: 'boom', generated_at: '2026-10-04 23:00:00 UTC' }]
  const mut = (f) => { const j = fixture(); f(j); return j }
  bad.push(mut((j) => { j.generated_at = '2026-10-04T23:00:00Z' }))
  bad.push(mut((j) => { j.generated_at = '2026-02-31 23:00:00 UTC' }))
  bad.push(mut((j) => { j.edge_proof = { built: false, message: 'edge proof not built' } }))
  bad.push(mut((j) => { j.edge_proof.built = 'true' }))
  bad.push(mut((j) => { delete j.long_term.cards }))
  bad.push(mut((j) => { card(j).verdict = 'GREAT' }))
  bad.push(mut((j) => { card(j).verdict = 'proven' }))
  bad.push(mut((j) => { card(j).ev = '0.4' }))
  bad.push(mut((j) => { card(j).ev = null }))
  bad.push(mut((j) => { card(j).ev = 1e9 }))
  bad.push(mut((j) => { card(j).ci95 = [0.1] }))
  bad.push(mut((j) => { card(j).ci95 = [0.1, null] }))
  bad.push(mut((j) => { card(j).n = -1 }))
  bad.push(mut((j) => { card(j).n = 1.5 }))
  for (const j of bad) assert.equal(sanitizeEdge(j, NOW).state, 'unknown', JSON.stringify(j)?.slice(0, 80))
})

test('stale and future data are unknown', () => {
  const j = fixture()
  const old = sanitizeEdge(j, NOW + (EDGE_TTL_S + 1) * 1000)
  assert.equal(old.state, 'unknown')
  assert.match(old.reason, /^stale/)
  assert.match(sanitizeEdge(j, NOW - 3_600_000).reason, /future/)
  assert.equal(sanitizeEdge(j, NOW - 30_000).ageSeconds, 0)
})
