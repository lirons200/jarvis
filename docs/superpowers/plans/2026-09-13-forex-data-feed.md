# Forex Data Feed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only OANDA forex price feed to the JARVIS bridge — a poller that caches prices for a small set of pairs, exposed via an MCP tool (`forex_price`) and an HTTP endpoint (`/forex/prices`).

**Architecture:** One new module, `bridge/forex.mjs`, holding pure/testable helpers (config parsing, response parsing) plus a poller with an in-memory cache. `bridge/server.mjs` wires it in: a boot-time `initForex()` call, a `jarvis_forex` MCP server entry, a `decideTool` allow-rule, and a `/forex/prices` route inside the existing `handleRequest`. Outbound OANDA calls reuse `net.mjs`'s SSRF-guarded `vetTarget`/`openRemote`, matching how `/img`, `/media`, and `/page` already fetch remote resources.

**Tech Stack:** Node.js (ESM), `zod` + `@anthropic-ai/claude-agent-sdk`'s `createSdkMcpServer`/`tool` (already used in `bridge/ui.mjs`), Node's built-in `node:test` runner (no new dependency — the repo currently has no test framework).

**Verified against OANDA v20 docs (2026-09-13):**
- Endpoint: `GET /v3/accounts/{accountID}/pricing?instruments=EUR_USD,GBP_USD,...`
- Auth: `Authorization: Bearer <token>`
- Hosts: practice `https://api-fxpractice.oanda.com`, live `https://api-fxtrade.oanda.com`
- Rate limit: 120 req/s — a 10s poll of a handful of pairs is nowhere near this
- Response `status` field is `"tradeable"` or `"non-tradeable"` (a string, not a boolean) — a closed market still returns **200 with `status: "non-tradeable"`**, not an error. This means the "don't treat market closure as a fault" requirement from the spec is satisfied naturally by only treating actual fetch/HTTP failures as errors — no separate market-hours calendar logic is needed.

---

## File Structure

- **Create:** `bridge/forex.mjs` — config helpers, OANDA client, poller, MCP server, HTTP route handler.
- **Create:** `bridge/forex.test.mjs` — unit tests for the pure helpers and the poller state machine (network calls are stubbed via dependency injection, never hit the real OANDA API).
- **Modify:** `bridge/server.mjs` — import and wire in `forex.mjs` (boot call, MCP server registration, `decideTool` rule, HTTP route).
- **Modify:** `package.json` — add a `"test": "node --test bridge/"` script.
- **Modify:** `README.md` — document the new `JARVIS_OANDA_*`/`JARVIS_FOREX_*` env vars in the existing Bridge config table.

---

### Task 1: Config helpers (env parsing, validation, clamping)

**Files:**
- Create: `bridge/forex.mjs`
- Test: `bridge/forex.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `bridge/forex.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveEnv, hostFor, validatePairs, clampPollInterval } from './forex.mjs'

test('resolveEnv defaults to practice', () => {
  delete process.env.JARVIS_OANDA_ENV
  delete process.env.JARVIS_OANDA_ALLOW_LIVE
  assert.equal(resolveEnv(), 'practice')
})

test('resolveEnv rejects an unknown value', () => {
  process.env.JARVIS_OANDA_ENV = 'sandbox'
  assert.throws(() => resolveEnv(), /must be "practice" or "live"/)
  delete process.env.JARVIS_OANDA_ENV
})

test('resolveEnv refuses live without the explicit allow flag', () => {
  process.env.JARVIS_OANDA_ENV = 'live'
  delete process.env.JARVIS_OANDA_ALLOW_LIVE
  assert.throws(() => resolveEnv(), /JARVIS_OANDA_ALLOW_LIVE/)
  delete process.env.JARVIS_OANDA_ENV
})

test('resolveEnv allows live once the flag is set', () => {
  process.env.JARVIS_OANDA_ENV = 'live'
  process.env.JARVIS_OANDA_ALLOW_LIVE = 'true'
  assert.equal(resolveEnv(), 'live')
  delete process.env.JARVIS_OANDA_ENV
  delete process.env.JARVIS_OANDA_ALLOW_LIVE
})

test('hostFor maps environments to the correct OANDA hosts', () => {
  assert.equal(hostFor('practice'), 'https://api-fxpractice.oanda.com')
  assert.equal(hostFor('live'), 'https://api-fxtrade.oanda.com')
})

test('validatePairs keeps well-formed instrument names and drops the rest', () => {
  const { valid, dropped } = validatePairs('EUR_USD, gbp_usd,not-a-pair,USD_JPY')
  assert.deepEqual(valid, ['EUR_USD', 'GBP_USD', 'USD_JPY'])
  assert.deepEqual(dropped, ['NOT-A-PAIR'])
})

test('validatePairs falls back to the documented default when unset', () => {
  const { valid } = validatePairs(undefined)
  assert.deepEqual(valid, ['EUR_USD', 'GBP_USD', 'USD_JPY'])
})

test('validatePairs throws if nothing valid remains', () => {
  assert.throws(() => validatePairs('bogus,also-bad'), /no valid instrument/)
})

test('clampPollInterval clamps to [2000, 60000] and falls back to 10000', () => {
  assert.equal(clampPollInterval(undefined), 10000)
  assert.equal(clampPollInterval('0'), 2000)
  assert.equal(clampPollInterval(999999), 60000)
  assert.equal(clampPollInterval('not a number'), 10000)
  assert.equal(clampPollInterval(15000), 15000)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test bridge/forex.test.mjs`
Expected: FAIL — `bridge/forex.mjs` does not exist yet.

- [ ] **Step 3: Write the implementation**

Create `bridge/forex.mjs` starting with this content:

```js
/**
 * Read-only OANDA forex price feed for the bridge.
 *
 * A poller caches the latest bid/ask for a small set of pairs; both the
 * `forex_price` MCP tool and the `/forex/prices` HTTP route only ever read
 * that cache — neither triggers an OANDA call on demand, so a hammering
 * client cannot drive extra API volume against the account.
 */

import { openRemote, vetTarget, PROXY_UA } from './net.mjs'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

const HOSTS = {
  practice: 'https://api-fxpractice.oanda.com',
  live: 'https://api-fxtrade.oanda.com',
}

/**
 * `JARVIS_OANDA_ENV=live` is a real-money account, so it needs a second,
 * explicit flag on top of the environment selector — the same default-deny
 * shape as JARVIS_ALLOW_WRITES elsewhere in the bridge.
 */
export function resolveEnv() {
  const env = (process.env.JARVIS_OANDA_ENV ?? 'practice').trim().toLowerCase()
  if (env !== 'practice' && env !== 'live') {
    throw new Error(`JARVIS_OANDA_ENV must be "practice" or "live", got "${env}"`)
  }
  if (env === 'live' && process.env.JARVIS_OANDA_ALLOW_LIVE !== 'true') {
    throw new Error(
      'JARVIS_OANDA_ENV=live requires JARVIS_OANDA_ALLOW_LIVE=true to also be ' +
        'set — this is a real-money account, not a safety default to fall into.',
    )
  }
  return env
}

export function hostFor(env) {
  return HOSTS[env]
}

const PAIR_RE = /^[A-Z]{3}_[A-Z]{3}$/
const DEFAULT_PAIRS = 'EUR_USD,GBP_USD,USD_JPY'

/**
 * One bad instrument name must not sink the whole batch request, so bad
 * entries are dropped here rather than sent to OANDA and left to 400 the
 * lot.
 */
export function validatePairs(raw) {
  const wanted = (raw ?? DEFAULT_PAIRS)
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
  const valid = []
  const dropped = []
  for (const p of wanted) {
    if (PAIR_RE.test(p)) valid.push(p)
    else dropped.push(p)
  }
  if (!valid.length) {
    throw new Error(`JARVIS_FOREX_PAIRS contained no valid instrument names: ${raw}`)
  }
  return { valid, dropped }
}

const MIN_POLL_MS = 2000
const MAX_POLL_MS = 60_000
const DEFAULT_POLL_MS = 10_000

export function clampPollInterval(raw) {
  const n = Number(raw)
  if (!Number.isFinite(n)) return DEFAULT_POLL_MS
  return Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, Math.round(n)))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test bridge/forex.test.mjs`
Expected: PASS, all tests in the file green.

- [ ] **Step 5: Commit**

```bash
git add bridge/forex.mjs bridge/forex.test.mjs
git commit -m "forex: add config helpers (env, host, pairs, poll interval)"
```

---

### Task 2: Parse OANDA's pricing response

**Files:**
- Modify: `bridge/forex.mjs`
- Modify: `bridge/forex.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `bridge/forex.test.mjs`:

```js
import { parsePricingResponse } from './forex.mjs'

test('parsePricingResponse extracts bid/ask/time/tradeable per instrument', () => {
  const fixture = {
    prices: [
      {
        instrument: 'EUR_USD',
        status: 'tradeable',
        bids: [{ price: '1.13015', liquidity: 10000000 }],
        asks: [{ price: '1.13028', liquidity: 10000000 }],
        time: '2026-09-13T18:41:36.201836422Z',
      },
    ],
  }
  const out = parsePricingResponse(fixture, 1234)
  assert.deepEqual(out, {
    EUR_USD: {
      bid: 1.13015,
      ask: 1.13028,
      time: '2026-09-13T18:41:36.201836422Z',
      tradeable: true,
      fetchedAtMs: 1234,
    },
  })
})

test('parsePricingResponse marks a closed-market instrument as not tradeable, not an error', () => {
  const fixture = {
    prices: [
      {
        instrument: 'EUR_USD',
        status: 'non-tradeable',
        bids: [{ price: '1.13015' }],
        asks: [{ price: '1.13028' }],
        time: '2026-09-13T18:41:36Z',
      },
    ],
  }
  const out = parsePricingResponse(fixture, 1234)
  assert.equal(out.EUR_USD.tradeable, false)
  assert.equal(out.EUR_USD.bid, 1.13015)
})

test('parsePricingResponse tolerates a missing prices array', () => {
  assert.deepEqual(parsePricingResponse({}, 1234), {})
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test bridge/forex.test.mjs`
Expected: FAIL — `parsePricingResponse` is not exported yet.

- [ ] **Step 3: Write the implementation**

Append to `bridge/forex.mjs`:

```js
/**
 * Parses one `/v3/accounts/{id}/pricing` response into the cache shape.
 * Exported standalone so it can be unit-tested against fixture JSON without
 * a network call. A closed-market instrument still comes back as a normal
 * 200 with `status: "non-tradeable"` — that is not a fetch failure, so it is
 * represented here, not thrown.
 */
export function parsePricingResponse(json, fetchedAtMs) {
  const out = {}
  for (const p of json?.prices ?? []) {
    const bid = p.bids?.[0]?.price
    const ask = p.asks?.[0]?.price
    out[p.instrument] = {
      bid: bid !== undefined ? Number(bid) : null,
      ask: ask !== undefined ? Number(ask) : null,
      time: p.time ?? null,
      tradeable: p.status === 'tradeable',
      fetchedAtMs,
    }
  }
  return out
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test bridge/forex.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bridge/forex.mjs bridge/forex.test.mjs
git commit -m "forex: parse OANDA pricing responses"
```

---

### Task 3: OANDA fetch (SSRF-guarded, credentials never logged)

**Files:**
- Modify: `bridge/forex.mjs`

- [ ] **Step 1: Write the implementation**

No unit test here — this function makes a real network call, and the repo's
existing convention (see `net.mjs`) is to test the pure logic around network
calls, not the calls themselves. It will be exercised by the manual
verification in Task 6. Append to `bridge/forex.mjs`:

```js
const FETCH_TIMEOUT_MS = 8000
const MAX_RESPONSE_BYTES = 256 * 1024

async function readJsonBody(res, maxBytes) {
  const chunks = []
  let size = 0
  for await (const chunk of res) {
    size += chunk.length
    if (size > maxBytes) {
      res.destroy()
      throw new Error('oanda response too large')
    }
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * One pricing request. `host`/`accountId`/`apiKey`/`pairs` come from
 * `buildConfig()` below. Routed through `net.mjs`'s `vetTarget`/`openRemote`
 * — the same SSRF guard every other outbound bridge request uses — even
 * though OANDA's hosts are fixed, so this can never silently diverge from
 * that convention.
 *
 * The account id is part of the URL path (OANDA's own scheme). Errors thrown
 * here carry a fixed message plus the HTTP status only — never the request
 * URL or the API key — so a caller that logs `err.message` can never leak
 * either.
 */
export async function fetchPricingOnce({ host, accountId, apiKey, pairs }) {
  const url = vetTarget(
    `${host}/v3/accounts/${encodeURIComponent(accountId)}/pricing` +
      `?instruments=${pairs.map(encodeURIComponent).join(',')}`,
  )
  const { res } = await openRemote(
    url,
    {
      'user-agent': PROXY_UA,
      authorization: `Bearer ${apiKey}`,
      accept: 'application/json',
    },
    FETCH_TIMEOUT_MS,
  )
  const status = res.statusCode ?? 0
  if (status !== 200) {
    res.resume()
    const err = new Error(`oanda pricing request failed with status ${status}`)
    err.status = status
    throw err
  }
  return readJsonBody(res, MAX_RESPONSE_BYTES)
}
```

- [ ] **Step 2: Commit**

```bash
git add bridge/forex.mjs
git commit -m "forex: fetch OANDA pricing through the SSRF-guarded client"
```

---

### Task 4: Poller — in-flight guard, backoff, staleness

**Files:**
- Modify: `bridge/forex.mjs`
- Modify: `bridge/forex.test.mjs`

- [ ] **Step 1: Write the failing tests**

`pollOnce` takes the fetch function as a parameter specifically so tests can
inject a stub instead of hitting the network. Append to `bridge/forex.test.mjs`:

```js
import { pollOnce, getForexCache, resetForexStateForTests } from './forex.mjs'

test('pollOnce populates the cache on success', async () => {
  resetForexStateForTests()
  const fakeFetch = async () => ({
    prices: [
      {
        instrument: 'EUR_USD',
        status: 'tradeable',
        bids: [{ price: '1.1' }],
        asks: [{ price: '1.2' }],
        time: 't1',
      },
    ],
  })
  await pollOnce({ pairs: ['EUR_USD'] }, fakeFetch)
  const cache = getForexCache()
  assert.equal(cache.EUR_USD.bid, 1.1)
  assert.equal(cache.EUR_USD.stale, false)
})

test('pollOnce keeps the last known price and marks it stale on failure', async () => {
  resetForexStateForTests()
  const okFetch = async () => ({
    prices: [{ instrument: 'EUR_USD', status: 'tradeable', bids: [{ price: '1.1' }], asks: [{ price: '1.2' }], time: 't1' }],
  })
  await pollOnce({ pairs: ['EUR_USD'] }, okFetch)

  const failFetch = async () => { throw new Error('network down') }
  await pollOnce({ pairs: ['EUR_USD'], staleAfterMs: -1 }, failFetch)

  const cache = getForexCache()
  assert.equal(cache.EUR_USD.bid, 1.1, 'last known price is kept')
  assert.equal(cache.EUR_USD.stale, true)
})

test('pollOnce skips a tick already in flight', async () => {
  resetForexStateForTests()
  let calls = 0
  let releaseFirst
  const slowFetch = () =>
    new Promise((resolve) => {
      calls++
      releaseFirst = () => resolve({ prices: [] })
    })

  const first = pollOnce({ pairs: ['EUR_USD'] }, slowFetch)
  const second = pollOnce({ pairs: ['EUR_USD'] }, slowFetch) // should no-op, first still in flight
  await second
  assert.equal(calls, 1)
  releaseFirst()
  await first
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test bridge/forex.test.mjs`
Expected: FAIL — `pollOnce`, `getForexCache`, `resetForexStateForTests` are not exported yet.

- [ ] **Step 3: Write the implementation**

Append to `bridge/forex.mjs`:

```js
const DEFAULT_STALE_AFTER_MS = 5 * 60 * 1000
const MAX_BACKOFF_MS = 5 * 60 * 1000

const state = {
  cache: {},
  polling: false,
  failCount: 0,
  lastError: null,
  lastSuccessAtMs: null,
  timer: null,
}

/** Test-only: clears module state between tests so they don't leak into each other. */
export function resetForexStateForTests() {
  state.cache = {}
  state.polling = false
  state.failCount = 0
  state.lastError = null
  state.lastSuccessAtMs = null
  if (state.timer) clearTimeout(state.timer)
  state.timer = null
}

export function getForexCache() {
  return state.cache
}

function logPoll(entry) {
  console.log('[jarvis:forex]', JSON.stringify(entry))
}

/**
 * One poll attempt. Guarded against overlap: if a previous call is still
 * in flight, this call returns immediately rather than starting a second
 * request. `fetchFn` defaults to the real OANDA call but is a parameter so
 * tests can inject a stub.
 */
export async function pollOnce(config, fetchFn = fetchPricingOnce) {
  if (state.polling) return
  state.polling = true
  const startedAt = Date.now()
  try {
    const json = await fetchFn(config)
    const parsed = parsePricingResponse(json, Date.now())
    for (const [pair, data] of Object.entries(parsed)) {
      state.cache[pair] = { ...data, stale: false }
      logPoll({
        pair,
        bid: data.bid,
        ask: data.ask,
        time: data.time,
        latencyMs: Date.now() - startedAt,
        ok: true,
      })
    }
    state.lastError = null
    state.lastSuccessAtMs = Date.now()
    state.failCount = 0
  } catch (err) {
    state.failCount++
    state.lastError = String(err?.message ?? err)
    console.error(`[jarvis:forex] poll failed (attempt ${state.failCount}): ${state.lastError}`)
    const staleAfterMs = config.staleAfterMs ?? DEFAULT_STALE_AFTER_MS
    for (const pair of Object.keys(state.cache)) {
      const age = Date.now() - state.cache[pair].fetchedAtMs
      state.cache[pair].stale = age > staleAfterMs
    }
  } finally {
    state.polling = false
  }
}

/**
 * Starts the recurring poll. Backs off exponentially (capped) on repeated
 * failure instead of hammering OANDA at the fixed interval during an outage;
 * resets to the configured interval as soon as a poll succeeds again.
 */
export function startForexPoller(config) {
  const baseIntervalMs = clampPollInterval(config.pollIntervalMs)
  const nextDelay = () =>
    state.failCount > 0
      ? Math.min(MAX_BACKOFF_MS, baseIntervalMs * 2 ** Math.min(state.failCount, 6))
      : baseIntervalMs

  const tick = async () => {
    await pollOnce(config)
    state.timer = setTimeout(tick, nextDelay())
  }
  void tick()
  return () => {
    if (state.timer) clearTimeout(state.timer)
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test bridge/forex.test.mjs`
Expected: PASS, all tests in the file green.

- [ ] **Step 5: Commit**

```bash
git add bridge/forex.mjs bridge/forex.test.mjs
git commit -m "forex: poller with in-flight guard, backoff, and staleness tracking"
```

---

### Task 5: MCP tool, HTTP route, and startup wiring

**Files:**
- Modify: `bridge/forex.mjs`

- [ ] **Step 1: Write the implementation**

Append to `bridge/forex.mjs`:

```js
export function forexServer() {
  return createSdkMcpServer({
    name: 'jarvis_forex',
    version: '1.0.0',
    instructions:
      'Read-only forex price lookups from the cached OANDA feed. Prices ' +
      'refresh on their own schedule — this never makes a live network call.',
    tools: [
      tool(
        'forex_price',
        'Get the latest cached bid/ask price for a forex pair, e.g. EUR_USD.',
        { pair: z.string().describe('Instrument name, e.g. EUR_USD, GBP_USD') },
        async (args) => {
          const pair = String(args.pair ?? '').trim().toUpperCase()
          const entry = getForexCache()[pair]
          if (!entry) {
            return {
              isError: true,
              content: [{ type: 'text', text: `No price cached for ${pair}.` }],
            }
          }
          const bits = [`${pair} bid ${entry.bid}, ask ${entry.ask}`]
          if (!entry.tradeable) bits.push('market currently closed')
          else if (entry.stale) bits.push('data may be stale')
          return { content: [{ type: 'text', text: bits.join(' — ') }] }
        },
      ),
    ],
  })
}

/**
 * `GET /forex/prices`. Dispatched from inside `handleRequest` in
 * server.mjs, so it inherits the same origin check as every other bridge
 * route — never register this on a separate, unguarded listener.
 */
export function forexRoute(req, res, cors) {
  res.writeHead(200, { ...cors, 'content-type': 'application/json' })
  res.end(
    JSON.stringify({
      prices: getForexCache(),
      lastError: state.lastError,
      lastSuccessAtMs: state.lastSuccessAtMs,
    }),
  )
}

/**
 * Boot-time setup. Validates credentials with one test fetch before
 * starting the recurring poller — fails fast and loudly rather than
 * retrying an invalid key forever. Returns null (forex disabled) if the
 * required env vars are absent, so the bridge still starts fine without
 * an OANDA account configured.
 */
export async function initForex() {
  const apiKey = process.env.JARVIS_OANDA_API_KEY
  const accountId = process.env.JARVIS_OANDA_ACCOUNT_ID
  if (!apiKey || !accountId) {
    console.log(
      '[jarvis:forex] disabled — set JARVIS_OANDA_API_KEY and ' +
        'JARVIS_OANDA_ACCOUNT_ID to enable the forex feed',
    )
    return null
  }

  let env
  try {
    env = resolveEnv()
  } catch (err) {
    console.error(`[jarvis:forex] disabled — ${err.message}`)
    return null
  }

  const { valid: pairs, dropped } = validatePairs(process.env.JARVIS_FOREX_PAIRS)
  if (dropped.length) {
    console.warn(`[jarvis:forex] dropped invalid pairs: ${dropped.join(', ')}`)
  }
  const pollIntervalMs = clampPollInterval(process.env.JARVIS_FOREX_POLL_INTERVAL_MS)
  const config = { host: hostFor(env), accountId, apiKey, pairs, pollIntervalMs }

  try {
    await fetchPricingOnce(config)
  } catch (err) {
    console.error(`[jarvis:forex] disabled — startup credential check failed: ${err.message}`)
    return null
  }

  console.log(
    `[jarvis:forex] ${env} · pairs ${pairs.join(', ')} · polling every ${pollIntervalMs}ms`,
  )
  startForexPoller(config)
  return config
}
```

- [ ] **Step 2: Commit**

```bash
git add bridge/forex.mjs
git commit -m "forex: MCP tool, HTTP route, and boot-time startup wiring"
```

---

### Task 6: Wire into server.mjs

**Files:**
- Modify: `bridge/server.mjs`

- [ ] **Step 1: Import the new module**

At the top of `bridge/server.mjs`, alongside the other bridge module imports (near line 21-22):

```js
import { uiServer } from './ui.mjs'
import { forexServer, forexRoute, initForex } from './forex.mjs'
```

- [ ] **Step 2: Call `initForex()` at boot**

`bridge/server.mjs` already does top-level `await` (e.g. `const http = await import('node:http')` at line 663). Add this near that line, before `server.listen(PORT)`:

```js
const FOREX_CONFIG = await initForex()
```

- [ ] **Step 3: Add the `/forex/prices` route**

Inside `handleRequest`, add this branch next to the `/health` branch (after the `/health` block, around line 688):

```js
  if (req.method === 'GET' && req.url === '/forex/prices') {
    return forexRoute(req, res, cors)
  }
```

- [ ] **Step 4: Register the MCP server**

Inside the `mcpServers` object passed to `query()` (around line 1200-1217), add the forex server next to `jarvis_ui`:

```js
      mcpServers: {
        ...MCP_SERVERS,
        jarvis: displayServer(
          (panel) => send({ type: 'panel', panel }),
          (blade) => send({ type: 'blade', blade }),
        ),
        jarvis_ui: uiServer((op, args) => send({ type: 'ui', op, args })),
        jarvis_forex: forexServer(),
        jarvis_chrome: chromeServer({ allowWrites: ALLOW_WRITES }),
        jarvis_eyes: visionServer(ask),
      },
```

- [ ] **Step 5: Allow the tool in `decideTool`**

`forex_price` is read-only and, like the camera and the interface controls, does not fit the generic verb-matching rules cleanly (it starts with no read verb but changes nothing). Add it next to the `jarvis_eyes` case inside `decideTool` (around line 280):

```js
    // Cached price lookups. Read-only: the poller is the only thing that
    // ever calls OANDA, this tool only reads what it already fetched.
    if (server === 'jarvis_forex') return true
```

- [ ] **Step 6: Log forex status in the boot banner**

Near the other boot `console.log` lines (around line 1007-1011), add:

```js
console.log(
  FOREX_CONFIG
    ? `[jarvis] forex feed active`
    : '[jarvis] forex feed disabled — set JARVIS_OANDA_API_KEY and JARVIS_OANDA_ACCOUNT_ID to enable',
)
```

- [ ] **Step 7: Commit**

```bash
git add bridge/server.mjs
git commit -m "forex: wire the feed into the bridge (route, MCP server, boot check)"
```

---

### Task 7: Test script and README docs

**Files:**
- Modify: `package.json`
- Modify: `README.md`

- [ ] **Step 1: Add the test script**

In `package.json`, add to `"scripts"` (there is currently no test script):

```json
    "test": "node --test bridge/",
```

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: PASS — all tests from Tasks 1, 2, and 4 run and succeed.

- [ ] **Step 3: Document the env vars**

In `README.md`, in the existing "### Bridge" config table (the one listing `JARVIS_BRIDGE_PORT`, `JARVIS_MODEL`, etc.), add these rows:

```markdown
| `JARVIS_OANDA_API_KEY` | — | OANDA personal access token. Unset disables the forex feed entirely. |
| `JARVIS_OANDA_ACCOUNT_ID` | — | OANDA account id. Unset disables the forex feed entirely. |
| `JARVIS_OANDA_ENV` | `practice` | `practice` or `live`. `live` also requires `JARVIS_OANDA_ALLOW_LIVE=true`. |
| `JARVIS_OANDA_ALLOW_LIVE` | unset | Must be `true` for `JARVIS_OANDA_ENV=live` to start — a safety rail against accidentally polling a real-money account. |
| `JARVIS_FOREX_PAIRS` | `EUR_USD,GBP_USD,USD_JPY` | Comma-separated OANDA instrument names to poll. |
| `JARVIS_FOREX_POLL_INTERVAL_MS` | `10000` | Poll interval, clamped to 2000-60000ms. |
```

- [ ] **Step 4: Commit**

```bash
git add package.json README.md
git commit -m "forex: add test script and document the new env vars"
```

---

### Task 8: Manual end-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Start the bridge with real (practice) OANDA credentials**

```bash
JARVIS_OANDA_API_KEY=<your-practice-token> JARVIS_OANDA_ACCOUNT_ID=<your-practice-account-id> npm run bridge
```

Expected boot log includes:
```
[jarvis:forex] practice · pairs EUR_USD, GBP_USD, USD_JPY · polling every 10000ms
[jarvis] forex feed active
```

- [ ] **Step 2: Check the HTTP endpoint**

```bash
curl http://localhost:8787/forex/prices
```

Expected: JSON with a `prices` object containing `EUR_USD`, `GBP_USD`, `USD_JPY`, each with `bid`, `ask`, `time`, `tradeable`, `stale`.

- [ ] **Step 3: Verify the safety rail**

```bash
JARVIS_OANDA_API_KEY=x JARVIS_OANDA_ACCOUNT_ID=x JARVIS_OANDA_ENV=live npm run bridge
```

Expected: bridge logs `[jarvis:forex] disabled — JARVIS_OANDA_ENV=live requires JARVIS_OANDA_ALLOW_LIVE=true...` and continues running with the forex feed off (does not crash the whole bridge).

- [ ] **Step 4: Verify voice/tool path**

With the bridge and frontend both running (`npm start`), open the app in Chrome and ask "What's EUR/USD at?" — JARVIS should answer with a spoken price.

---

## Self-Review Notes

- **Spec coverage:** startup validation (spec §"Startup behavior") → Task 5 `initForex`. In-flight guard + timeout (spec §"Polling behavior") → Task 4 (guard done; a per-request timeout already exists inside `fetchPricingOnce` via `openRemote`'s `timeoutMs`, satisfying "hung request cannot stall the poller"). Backoff → Task 4. Market-hours awareness → satisfied by design (see header note) rather than a separate code path — confirmed against real OANDA response shape, not assumed. Logging shape → Task 4 `logPoll`. Security (no secrets in output/logs, origin-gated route, cache-only reads, live/practice rail) → Tasks 3, 5, 6. Forward note on future trading tools going through `decideTool` → already stated in the spec itself; no code needed this phase.
- **No placeholders:** every step above has complete, runnable code.
- **Type/name consistency check:** `getForexCache`, `pollOnce`, `startForexPoller`, `resetForexStateForTests`, `forexServer`, `forexRoute`, `initForex` are used with the same names and signatures everywhere they appear across tasks.
