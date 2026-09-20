import test from 'node:test'
import assert from 'node:assert/strict'
import { buildHealth } from './health.mjs'

test('buildHealth reports booleans and uptime', () => {
  const h = buildHealth({
    uptimeSeconds: 12.9,
    version: '1.2.3',
    tts: true,
    stt: false,
    forexFeed: true,
    trading: { enabled: true, armed: true, halted: false },
    telegram: true,
  })
  assert.deepEqual(h, {
    ok: true,
    ready: false,
    uptime: 12,
    version: '1.2.3',
    tts: true,
    stt: false,
    forexFeed: true,
    trading: { enabled: true, armed: true, halted: false },
    telegram: true,
  })
})

test('buildHealth boot-window shape: null configs, still ok, not ready', () => {
  const h = buildHealth({
    uptimeSeconds: 0,
    version: '1',
    tts: false,
    stt: false,
    forexFeed: null,
    trading: { enabled: true, armed: Boolean(null), halted: false },
    telegram: null,
    ready: false,
  })
  assert.equal(h.ok, true)
  assert.equal(h.ready, false)
  assert.equal(h.forexFeed, false)
  assert.equal(h.telegram, false)
  assert.deepEqual(h.trading, { enabled: true, armed: false, halted: false })
  assert.ok('tts' in h && 'stt' in h)
})

test('buildHealth coerces missing/odd input safely', () => {
  const h = buildHealth({ uptimeSeconds: -5, version: 3 })
  assert.equal(h.uptime, 0)
  assert.equal(h.version, 'unknown')
  assert.deepEqual(h.trading, { enabled: false, armed: false, halted: false })
  assert.equal(h.forexFeed, false)
  assert.equal(h.telegram, false)
})

test('buildHealth never passes through unknown (secret-bearing) fields', () => {
  const h = buildHealth({
    uptimeSeconds: 1,
    version: 'x',
    forexFeed: 'abc-token',
    telegram: 'bot123:secret',
    trading: { enabled: 1, armed: 1, halted: 0, accountId: '101-001', positions: [1] },
    apiKey: 'sk-secret',
  })
  const json = JSON.stringify(h)
  for (const s of ['abc-token', 'secret', '101-001', 'positions', 'sk-']) assert.ok(!json.includes(s))
  assert.equal(h.forexFeed, true)
})
