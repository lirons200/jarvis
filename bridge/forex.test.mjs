import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveEnv,
  hostFor,
  validatePairs,
  clampPollInterval,
  parsePricingResponse,
  pollOnce,
  getForexCache,
  resetForexStateForTests,
} from './forex.mjs'

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
  await pollOnce({ pairs: ['EUR_USD'] }, okFetch)

  const failFetch = async () => {
    throw new Error('network down')
  }
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
