import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ALLOWED_PATHS, botGet, isAllowedPath, parseBaseUrl } from './bot-client.mjs'

const okJson = (body) => async () => ({ statusCode: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(body) })

test('parseBaseUrl accepts loopback http and any https origin', () => {
  assert.deepEqual(parseBaseUrl('http://127.0.0.1:18080'), { ok: true, origin: 'http://127.0.0.1:18080' })
  assert.equal(parseBaseUrl('http://localhost:18080').ok, true)
  assert.equal(parseBaseUrl('http://[::1]:18080').ok, true)
  assert.equal(parseBaseUrl('https://bot.example.com').ok, true)
})

test('parseBaseUrl refuses plain http to a non-loopback host', () => {
  const r = parseBaseUrl('http://203.0.113.9:8080')
  assert.equal(r.ok, false)
  assert.equal(r.kind, 'bad_config')
  assert.match(r.detail, /loopback|tunnel|https/i)
})

test('parseBaseUrl refuses credentials, paths, query strings, other protocols and junk', () => {
  for (const bad of ['http://user:pw@127.0.0.1:1', 'http://127.0.0.1:1/api', 'http://127.0.0.1:1/?x=1', 'ftp://127.0.0.1', 'not a url', 'http://127.0.0.1:1/#f']) {
    assert.equal(parseBaseUrl(bad).ok, false, bad)
  }
})

test('parseBaseUrl reports not_configured for unset or blank', () => {
  for (const v of [undefined, '', '   ', null]) assert.equal(parseBaseUrl(v).kind, 'not_configured')
})

test('only /api/copilot is allowed in v1; everything else, including the state-changing paths, never is', () => {
  assert.deepEqual([...ALLOWED_PATHS], ['/api/copilot'])
  for (const bad of ['/api/mission/epoch', '/api/refresh-trades', '/api/status', '/api/mission', '/api//copilot', '/api/../etc', '/api/%2e%2e/copilot', '/api/copilot?x=1', '/api/copilot/', '/API/copilot', '', undefined, 5]) {
    assert.equal(isAllowedPath(bad), false, String(bad))
  }
})

test('botGet always sends GET, to the configured origin plus the allowed path', async () => {
  const calls = []
  const base = parseBaseUrl('http://127.0.0.1:18080')
  const res = await botGet(base, '/api/copilot', { request: async (url, opts) => { calls.push({ url, opts }); return okJson({ a: 1 })() } })
  assert.deepEqual(res, { ok: true, json: { a: 1 } })
  assert.deepEqual(calls, [{ url: 'http://127.0.0.1:18080/api/copilot', opts: { method: 'GET' } }])
})

test('botGet refuses disallowed paths without making any request', async () => {
  let called = false
  const res = await botGet(parseBaseUrl('http://127.0.0.1:1'), '/api/mission/epoch', { request: async () => { called = true } })
  assert.equal(res.kind, 'bad_path')
  assert.equal(called, false)
})

test('botGet maps failures to distinct kinds', async () => {
  const base = parseBaseUrl('http://127.0.0.1:1')
  const cases = [
    [async () => { throw Object.assign(new Error('x'), { code: 'ECONNREFUSED' }) }, 'unreachable'],
    [async () => ({ statusCode: 403, headers: {}, body: '' }), 'forbidden'],
    [async () => ({ statusCode: 500, headers: {}, body: '' }), 'http_error'],
    [async () => ({ statusCode: 302, headers: { location: 'http://evil.example/' }, body: '' }), 'http_error'],
    [async () => ({ statusCode: 200, headers: { 'content-type': 'text/html' }, body: '<html>' }), 'not_json'],
    [async () => ({ statusCode: 200, headers: { 'content-type': 'application/json' }, body: '{oops' }), 'not_json'],
    [async () => ({ tooLarge: true }), 'too_large'],
  ]
  for (const [request, kind] of cases) {
    const r = await botGet(base, '/api/copilot', { request })
    assert.equal(r.ok, false)
    assert.equal(r.kind, kind)
  }
})

test('botGet does not follow redirects', async () => {
  let n = 0
  const r = await botGet(parseBaseUrl('http://127.0.0.1:1'), '/api/copilot', { request: async () => { n++; return { statusCode: 301, headers: { location: '/api/mission/epoch' }, body: '' } } })
  assert.equal(n, 1)
  assert.equal(r.kind, 'http_error')
  assert.match(r.detail, /redirect/i)
})

test('botGet passes through an unusable base', async () => {
  assert.equal((await botGet(parseBaseUrl(undefined), '/api/copilot')).kind, 'not_configured')
})

// Real-socket behaviour: GET only, no redirect following, size cap, total deadline.
import http from 'node:http'
import { realRequest } from './bot-client.mjs'

function serve(handler) {
  return new Promise((resolve) => {
    const seen = []
    const server = http.createServer((req, res) => { seen.push({ method: req.method, url: req.url }); handler(req, res) })
    server.listen(0, '127.0.0.1', () => resolve({ server, seen, origin: `http://127.0.0.1:${server.address().port}` }))
  })
}

test('realRequest sends only GET and does not follow a redirect', { timeout: 15000 }, async () => {
  const s = await serve((req, res) => { res.writeHead(302, { location: '/api/mission/epoch' }); res.end() })
  try {
    const r = await botGet(parseBaseUrl(s.origin), '/api/copilot')
    assert.equal(r.kind, 'http_error')
    assert.deepEqual(s.seen, [{ method: 'GET', url: '/api/copilot' }])
  } finally { s.server.close() }
})

test('realRequest caps the body size', { timeout: 15000 }, async () => {
  const s = await serve((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('x'.repeat(2 * 1024 * 1024)) })
  try {
    assert.equal((await botGet(parseBaseUrl(s.origin), '/api/copilot')).kind, 'too_large')
  } finally { s.server.close() }
})

test('realRequest enforces a TOTAL deadline even if the server drips bytes', { timeout: 10000 }, async (t) => {
  const s = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    const timer = setInterval(() => res.write(' '), 200)
    res.on('close', () => clearInterval(timer))
  })
  // If the deadline regresses this test times out and its finally block never runs;
  // this hook still tears the dripping connection down so the runner can exit.
  t.after(() => { s.server.closeAllConnections(); s.server.close() })
  try {
    const started = Date.now()
    const r = await botGet(parseBaseUrl(s.origin), '/api/copilot', { request: (u, o) => realRequest(u, { ...o, timeoutMs: 1500 }) })
    assert.equal(r.kind, 'unreachable')
    assert.ok(Date.now() - started < 4000, 'deadline must not be an idle timeout')
  } finally { s.server.close() }
})
