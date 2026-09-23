import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { botRoute, botStatusServer, getBotState, isBotConfigured, resetBotStatusCache } from './bot-status.mjs'

const fixture = () => JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/copilot-sample.json', import.meta.url)), 'utf8'))
const ENV = { JARVIS_BOT_DASHBOARD_URL: 'http://127.0.0.1:18080' }
const NOW = Date.parse('2026-09-21T10:00:30Z')
const okReq = (body) => async () => ({ statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

beforeEach(() => resetBotStatusCache())

test('isBotConfigured reflects a valid URL only', () => {
  assert.equal(isBotConfigured(ENV), true)
  assert.equal(isBotConfigured({}), false)
  assert.equal(isBotConfigured({ JARVIS_BOT_DASHBOARD_URL: 'http://203.0.113.9:8080' }), false)
})

test('a reachable dashboard yields the sanitized state with reachability', async () => {
  const s = await getBotState({ nowMs: NOW, env: ENV, request: okReq(fixture()) })
  assert.equal(s.configured, true)
  assert.equal(s.state, 'warn')
  assert.equal(s.reachability.lastReachableAt, new Date(NOW).toISOString())
})

test('failures are unknown with a specific reason, and never carry old checks', async () => {
  const s = await getBotState({ nowMs: NOW, env: ENV, request: async () => { throw Object.assign(new Error('x'), { code: 'ECONNREFUSED' }) } })
  assert.equal(s.state, 'unknown')
  assert.match(s.reason, /unreachable \(network\)/)
  assert.deepEqual(s.checks, [])
})

test('403 and non-JSON get their own reasons', async () => {
  let s = await getBotState({ nowMs: NOW, env: ENV, request: async () => ({ statusCode: 403, headers: {}, body: '' }) })
  assert.match(s.reason, /forbidden/)
  resetBotStatusCache()
  s = await getBotState({ nowMs: NOW, env: ENV, request: async () => ({ statusCode: 200, headers: { 'content-type': 'text/html' }, body: 'x' }) })
  assert.match(s.reason, /JSON/)
})

test('after a good read then a failure, reachability keeps the last good time but state is unknown', async () => {
  await getBotState({ nowMs: NOW, env: ENV, request: okReq(fixture()) })
  const s = await getBotState({ nowMs: NOW + 60_000, env: ENV, request: async () => { throw Object.assign(new Error('x'), { code: 'ETIMEDOUT' }) } })
  assert.equal(s.state, 'unknown')
  assert.equal(s.reachability.lastReachableAt, new Date(NOW).toISOString())
})

test('results are cached for 10 seconds', async () => {
  let n = 0
  const request = async () => { n++; return okReq(fixture())() }
  await getBotState({ nowMs: NOW, env: ENV, request })
  await getBotState({ nowMs: NOW + 5_000, env: ENV, request })
  assert.equal(n, 1)
  await getBotState({ nowMs: NOW + 11_000, env: ENV, request })
  assert.equal(n, 2)
})

test('concurrent cold calls share one request', async () => {
  let n = 0
  const request = async () => { n++; await new Promise((r) => setTimeout(r, 20)); return okReq(fixture())() }
  const [a, b, c] = await Promise.all([1, 2, 3].map(() => getBotState({ nowMs: NOW, env: ENV, request })))
  assert.equal(n, 1)
  assert.equal(a.state, b.state)
  assert.equal(b.state, c.state)
})

test('a clock that goes backwards does not keep the cache fresh forever', async () => {
  let n = 0
  const request = async () => { n++; return okReq(fixture())() }
  await getBotState({ nowMs: NOW, env: ENV, request })
  await getBotState({ nowMs: NOW - 3_600_000, env: ENV, request })
  assert.equal(n, 2)
})

test('not configured is reported as such and makes no request', async () => {
  let called = false
  const s = await getBotState({ nowMs: NOW, env: {}, request: async () => { called = true } })
  assert.equal(s.configured, false)
  assert.equal(s.state, 'unknown')
  assert.equal(called, false)
})

test('the HUD route returns only a compact sanitized body', async () => {
  await getBotState({ nowMs: NOW, env: ENV, request: okReq(fixture()) })
  let status, headers, body
  const res = { writeHead: (s, h) => { status = s; headers = h }, end: (b) => { body = JSON.parse(b) } }
  await botRoute({}, res, { 'access-control-allow-origin': 'http://localhost:5173' }, { nowMs: NOW, env: ENV })
  assert.equal(status, 200)
  assert.equal(headers['content-type'], 'application/json')
  assert.equal(body.state, 'warn')
  assert.match(body.topIssue, /^trade_velocity: /)
  assert.deepEqual(Object.keys(body).sort(), ['ageSeconds', 'at', 'configured', 'headline', 'lastReachableAt', 'market', 'reason', 'stale', 'state', 'topIssue'])
})

test('the MCP server exposes exactly bot_status and bot_briefing', () => {
  const server = botStatusServer()
  assert.equal(server.name, 'jarvis_bot')
  assert.deepEqual(Object.keys(server.instance._registeredTools).sort(), ['bot_briefing', 'bot_status'])
})
