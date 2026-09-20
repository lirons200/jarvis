import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isPollConflict, nextBackoffMs, initialPollState, advancePollState,
  POLL_INTERVAL_MS, CONFLICT_BACKOFF_BASE_MS, ERROR_BACKOFF_BASE_MS, BACKOFF_CAP_MS, BACKOFF_LOG_EVERY_MS,
} from './telegram.mjs'

test('isPollConflict recognises both response shapes', () => {
  assert.equal(isPollConflict({ ok: false, error_code: 409, description: 'Conflict' }), true)
  const thrown = Object.assign(new Error('upstream said 409'), { status: 409 })
  assert.equal(isPollConflict(thrown), true)
  assert.equal(isPollConflict({ ok: false, error_code: 401 }), false)
  assert.equal(isPollConflict(new Error('ECONNRESET')), false)
  assert.equal(isPollConflict(null), false)
  assert.equal(isPollConflict(undefined), false)
})

test('nextBackoffMs escalates, doubles, and caps', () => {
  const seq = []
  let d = 0
  for (let i = 0; i < 8; i++) { d = nextBackoffMs(d, CONFLICT_BACKOFF_BASE_MS); seq.push(d) }
  assert.deepEqual(seq, [30000, 60000, 120000, 240000, 300000, 300000, 300000, 300000])
  assert.ok(seq.every((x) => x <= BACKOFF_CAP_MS))
})

test('healthy poller: normal interval, no log', () => {
  const r = advancePollState(initialPollState(), { kind: 'ok' }, 1000)
  assert.equal(r.delayMs, POLL_INTERVAL_MS)
  assert.equal(r.log, null)
  assert.deepEqual(r.state, initialPollState())
})

test('conflict: logs once, backs off, throttles repeats, re-logs after 10 min', () => {
  let r = advancePollState(initialPollState(), { kind: 'conflict' }, 0)
  assert.equal(r.delayMs, 30000)
  assert.equal(r.log.kind, 'conflict')
  assert.match(r.log.message, /same bot token/)
  assert.match(r.log.message, /own bot token/)
  let t = 0
  const delays = []
  let logs = 0
  for (let i = 0; i < 6; i++) {
    t += r.delayMs
    r = advancePollState(r.state, { kind: 'conflict' }, t)
    delays.push(r.delayMs)
    if (r.log) logs++
  }
  assert.deepEqual(delays, [60000, 120000, 240000, 300000, 300000, 300000])
  // t reaches 30+60+120+240+300+300 = 1050s, past the 600s throttle once.
  assert.equal(logs, 1)
  r = advancePollState(r.state, { kind: 'conflict' }, t + 1000)
  assert.equal(r.log, null)
  r = advancePollState(r.state, { kind: 'conflict' }, t + BACKOFF_LOG_EVERY_MS + 1000)
  assert.ok(r.log)
})

test('recovery resets state and logs once', () => {
  let s = advancePollState(initialPollState(), { kind: 'conflict' }, 0).state
  s = advancePollState(s, { kind: 'conflict' }, 30000).state
  const r = advancePollState(s, { kind: 'ok' }, 90000)
  assert.equal(r.log.kind, 'recovered')
  assert.equal(r.delayMs, POLL_INTERVAL_MS)
  assert.deepEqual(r.state, initialPollState())
  assert.equal(advancePollState(r.state, { kind: 'ok' }, 91000).log, null)
  const fresh = advancePollState(r.state, { kind: 'conflict' }, 100000)
  assert.equal(fresh.delayMs, CONFLICT_BACKOFF_BASE_MS)
  assert.ok(fresh.log)
})

test('generic errors back off from the smaller base and throttle logs', () => {
  let r = advancePollState(initialPollState(), { kind: 'error', message: 'poll failed: ECONNRESET' }, 0)
  assert.equal(r.delayMs, ERROR_BACKOFF_BASE_MS)
  assert.match(r.log.message, /ECONNRESET/)
  r = advancePollState(r.state, { kind: 'error', message: 'x' }, 5000)
  assert.equal(r.delayMs, 10000)
  assert.equal(r.log, null)
  for (let i = 0; i < 10; i++) r = advancePollState(r.state, { kind: 'error', message: 'x' }, 6000 + i)
  assert.equal(r.delayMs, BACKOFF_CAP_MS)
})

test('switching failure kind logs and restarts the backoff', () => {
  let s = advancePollState(initialPollState(), { kind: 'error', message: 'x' }, 0).state
  s = advancePollState(s, { kind: 'error', message: 'x' }, 1000).state
  const r = advancePollState(s, { kind: 'conflict' }, 2000)
  assert.equal(r.delayMs, CONFLICT_BACKOFF_BASE_MS)
  assert.ok(r.log)
})
