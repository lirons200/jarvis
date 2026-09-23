import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { cleanText, parseUtcTimestamp, sanitizeCopilot, worstOf } from './bot-copilot-schema.mjs'

const good = () => JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/copilot-sample.json', import.meta.url)), 'utf8'))
const NOW = Date.parse('2026-09-21T10:00:30Z')

test('a valid payload is sanitized and reports the worst status', () => {
  const s = sanitizeCopilot(good(), NOW)
  assert.equal(s.state, 'warn')
  assert.equal(s.ageSeconds, 30)
  assert.equal(s.stale, false)
  assert.equal(s.market, 'open')
  assert.deepEqual(s.headline, { live_strategies: 10, last_trade_trading_days: 5 })
  assert.equal(s.checks.length, 3)
  assert.deepEqual(Object.keys(s.checks[0]).sort(), ['evidence', 'id', 'since', 'status', 'threshold'])
})

test('an overall of ok cannot hide a crit check', () => {
  const p = good()
  p.overall = 'ok'
  p.checks[0].status = 'crit'
  assert.equal(sanitizeCopilot(p, NOW).state, 'crit')
})

test('unknown ranks above ok and below warn', () => {
  assert.equal(worstOf(['ok', 'unknown']), 'unknown')
  assert.equal(worstOf(['ok', 'unknown', 'warn']), 'warn')
  assert.equal(worstOf([]), 'unknown')
})

test('stale data becomes unknown and does not expose the old checks', () => {
  const s = sanitizeCopilot(good(), NOW + 3600 * 1000)
  assert.equal(s.state, 'unknown')
  assert.equal(s.stale, true)
  assert.match(s.reason, /stale/i)
  assert.deepEqual(s.checks, [])
})

test('a timestamp a few seconds in the future is accepted and its age is clamped to zero', () => {
  const s = sanitizeCopilot(good(), Date.parse('2026-09-21T09:59:30Z'))
  assert.equal(s.state, 'warn')
  assert.equal(s.ageSeconds, 0)
})

test('a timestamp in the future is unknown', () => {
  assert.equal(sanitizeCopilot(good(), Date.parse('2026-09-21T09:00:00Z')).state, 'unknown')
})

test('only the strict UTC timestamp format is accepted', () => {
  assert.notEqual(parseUtcTimestamp('2026-09-21T10:00:00Z'), null)
  assert.notEqual(parseUtcTimestamp('2026-09-21T10:00:00.123Z'), null)
  for (const bad of ['2026-09-21 10:00:00 UTC', '2026-09-21T10:00:00+00:00', '2026-09-21T10:00:00', '21/09/2026', '', null, 5]) {
    assert.equal(parseUtcTimestamp(bad), null, String(bad))
  }
})

test('schema mismatches are unknown', () => {
  const mutate = (fn) => { const p = good(); fn(p); return sanitizeCopilot(p, NOW) }
  assert.equal(mutate((p) => { p.schema_version = 2 }).state, 'unknown')
  assert.equal(mutate((p) => { p.generated_at = '2026-09-21 10:00:00 UTC' }).state, 'unknown')
  assert.equal(mutate((p) => { p.overall = 'fine' }).state, 'unknown')
  assert.equal(mutate((p) => { p.overall = 'constructor' }).state, 'unknown')
  assert.equal(mutate((p) => { p.checks = 'x' }).state, 'unknown')
  assert.equal(mutate((p) => { p.checks[0].id = 'has space' }).state, 'unknown')
  assert.equal(mutate((p) => { p.checks[0].id = 'a'.repeat(41) }).state, 'unknown')
  assert.equal(mutate((p) => { p.checks[0].status = 'toString' }).state, 'unknown')
  assert.equal(mutate((p) => { p.checks = Array.from({ length: 51 }, () => p.checks[0]) }).state, 'unknown')
  for (const bad of [null, undefined, [], 'x', 5]) assert.equal(sanitizeCopilot(bad, NOW).state, 'unknown')
})

test('free text is cleaned: control characters and newlines removed, length capped', () => {
  const p = good()
  p.checks[0].evidence = 'line1\nline2\u0000\u001b[31mred\u2028' + 'x'.repeat(500)
  const t = sanitizeCopilot(p, NOW).checks[0].evidence
  assert.ok(!/[\n\r\u0000\u001b\u2028]/.test(t))
  assert.ok(t.length <= 120)
  assert.equal(cleanText(123), '')
})

test('unknown keys are not forwarded and headline is whitelisted numbers only', () => {
  const p = good()
  p.account_id = '101-004-0000000-001'
  p.checks[0].secret = 'x'
  p.headline = { live_strategies: 3, balance: 96000, last_trade_trading_days: 'abc', evil: { a: 1 } }
  const s = sanitizeCopilot(p, NOW)
  assert.deepEqual(s.headline, { live_strategies: 3 })
  assert.ok(!JSON.stringify(s).includes('101-004'))
  assert.ok(!JSON.stringify(s).includes('secret'))
})

test('market state outside the enum becomes unknown; since must be a valid timestamp', () => {
  const p = good()
  p.market = { state: 'weird' }
  p.checks[0].since = 'yesterday'
  const s = sanitizeCopilot(p, NOW)
  assert.equal(s.market, 'unknown')
  assert.equal(s.checks[0].since, null)
})

test('an unknown payload from the bot (ttl 0) stays unknown', () => {
  const p = good()
  p.overall = 'unknown'
  p.ttl_s = 0
  p.checks = [{ id: 'copilot_payload', status: 'unknown', severity: 'crit', evidence: 'copilot.json missing or unreadable', threshold: '', since: null }]
  assert.equal(sanitizeCopilot(p, NOW).state, 'unknown')
})

test('ttl_s of zero, negative, missing or non-numeric is never fresh, even with overall ok', () => {
  for (const ttl of [0, -5, undefined, null, 'x', NaN]) {
    const p = good()
    p.overall = 'ok'
    p.checks.forEach((c) => { c.status = 'ok' })
    p.ttl_s = ttl
    assert.equal(sanitizeCopilot(p, NOW).state, 'unknown', String(ttl))
  }
})

test('a huge ttl_s is capped at one hour', () => {
  const p = good()
  p.ttl_s = 86400
  assert.equal(sanitizeCopilot(p, Date.parse('2026-09-21T11:30:00Z')).state, 'unknown')
})

test('impossible calendar dates are rejected, not rolled over', () => {
  assert.equal(parseUtcTimestamp('2026-02-31T10:00:00Z'), null)
  assert.equal(parseUtcTimestamp('2026-09-31T10:00:00Z'), null)
  assert.notEqual(parseUtcTimestamp('2026-02-28T10:00:00Z'), null)
})

test('bracket look-alikes, zero-width and bidi characters are removed from text', () => {
  const p = good()
  const cp = (...codes) => String.fromCodePoint(...codes)
  p.checks[0].evidence = 'a' + cp(0xff1c) + 'b' + cp(0xff1e) + ' ' + cp(0x3008) + 'x' + cp(0x3009) + ' ' + cp(0x2039) + 'y' + cp(0x203a) + ' z' + cp(0x200b) + 'w' + cp(0x202e) + 'v'
  assert.equal(sanitizeCopilot(p, NOW).checks[0].evidence, 'ab x y zwv')
})

// Cross-repo contract: payloads produced by the real Python watchdog (run_once, dry_run) from
// seeded state, generated once and checked in. If the sanitizer rejects one, that is a contract
// bug to report, not something to loosen the sanitizer around.
const real = (name) => JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8'))
const REAL_IDS = ['live_trades_schema', 'sizing_pinned_zero', 'trade_velocity']
const realNow = (p) => Date.parse(p.generated_at) + 30_000

test('contract: a real healthy payload from the Python watchdog is accepted', () => {
  const p = real('copilot-real.json')
  const s = sanitizeCopilot(p, realNow(p))
  assert.ok(['ok', 'warn', 'crit'].includes(s.state), `state was ${s.state}: ${s.reason}`)
  assert.ok(s.checks.length >= 3)
  assert.deepEqual(s.checks.map((c) => c.id).sort(), REAL_IDS)
  assert.equal(typeof s.headline.live_strategies, 'number')
  assert.equal(typeof s.headline.last_trade_trading_days, 'number')
  assert.equal(s.market, p.market.state)
})

test('contract: a real payload with a pinned-zero strategy is reported crit', () => {
  const p = real('copilot-real-crit.json')
  const s = sanitizeCopilot(p, realNow(p))
  assert.equal(s.state, 'crit')
  const sizing = s.checks.find((c) => c.id === 'sizing_pinned_zero')
  assert.ok(sizing, 'sizing_pinned_zero check present')
  assert.equal(sizing.status, 'crit')
  assert.deepEqual(s.checks.map((c) => c.id).sort(), REAL_IDS)
})

test('contract: real payloads carry no account ids or balances', () => {
  for (const name of ['copilot-real.json', 'copilot-real-crit.json']) {
    const text = readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8')
    assert.ok(!/balance|account/i.test(text), name)
    assert.ok(!/\d{3}-\d{3}-/.test(text), name)
  }
})
