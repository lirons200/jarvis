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
 * `initForex()` below. Routed through `net.mjs`'s `vetTarget`/`openRemote`
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
