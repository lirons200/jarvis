import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { computeDirection, formatRelativeTime, buildDetailHtml, startForexPolling, mergeForexPrices } from './forexTicker'
import type { ForexPriceEntry } from './forexTicker'
import { ALLOWED_CLASSES } from '../ui/sanitise'

test('computeDirection reports up when the bid rose above the baseline', () => {
  assert.equal(computeDirection(1.15, 1.1), 'up')
})

test('computeDirection reports down when the bid fell below the baseline', () => {
  assert.equal(computeDirection(1.05, 1.1), 'down')
})

test('computeDirection reports neutral when unchanged or no baseline yet', () => {
  assert.equal(computeDirection(1.1, 1.1), 'neutral')
  assert.equal(computeDirection(1.1, null), 'neutral')
})

test('formatRelativeTime renders seconds, minutes, and a floor of "just now"', () => {
  const now = 1_000_000
  assert.equal(formatRelativeTime(now, now), 'just now')
  assert.equal(formatRelativeTime(now - 4000, now), '4s ago')
  assert.equal(formatRelativeTime(now - 125_000, now), '2m ago')
})

test('buildDetailHtml renders a tradeable pair using only hud-* classes', () => {
  const html = buildDetailHtml('EUR_USD', {
    bid: 1.13015,
    ask: 1.13028,
    time: '2026-09-13T18:41:36Z',
    tradeable: true,
    stale: false,
    fetchedAtMs: 1000,
    baseline: 1.129,
  }, 5000)
  assert.match(html, /EUR_USD/)
  assert.match(html, /1\.13015/)
  assert.match(html, /1\.13028/)
  // spread = ask - bid, rounded to 5 decimal places
  assert.match(html, /0\.00013/)
  assert.match(html, /tradeable/)
  assert.doesNotMatch(html, /<script/i)
})

test('buildDetailHtml reports market closed for a non-tradeable pair', () => {
  const html = buildDetailHtml('EUR_USD', {
    bid: 1.13015,
    ask: 1.13028,
    time: '2026-09-13T18:41:36Z',
    tradeable: false,
    stale: false,
    fetchedAtMs: 1000,
    baseline: null,
  }, 5000)
  assert.match(html, /market closed/i)
})

test('computeDirection returns neutral when bid is null', () => {
  assert.equal(computeDirection(null, 1.1), 'neutral')
})

test('buildDetailHtml uses only allowed class names', () => {
  const allowedClasses = ALLOWED_CLASSES

  const html = buildDetailHtml('EUR_USD', {
    bid: 1.13015,
    ask: 1.13028,
    time: '2026-09-13T18:41:36Z',
    tradeable: true,
    stale: false,
    fetchedAtMs: 1000,
    baseline: 1.129,
  }, 5000)
  // Extract all class="..." tokens from the HTML
  const classRegex = /class="([^"]*)"/g
  const usedClasses = new Set<string>()
  let match
  while ((match = classRegex.exec(html)) !== null) {
    match[1].split(/\s+/).forEach((c) => {
      if (c) usedClasses.add(c)
    })
  }
  // Assert each used class is in ALLOWED_CLASSES
  usedClasses.forEach((c) => {
    assert.ok(
      allowedClasses.has(c),
      `Class "${c}" used in buildDetailHtml but not in ALLOWED_CLASSES`,
    )
  })
})

test('mergeForexPrices captures the first-seen bid as baseline', () => {
  const result = mergeForexPrices({}, {
    EUR_USD: { bid: 1.1, ask: 1.1002, time: '2026-09-13T00:00:00Z', tradeable: true, stale: false, fetchedAtMs: 1000 },
  })
  assert.equal(result.EUR_USD.baseline, 1.1)
})

test('mergeForexPrices never overwrites an existing baseline', () => {
  const current: Record<string, ForexPriceEntry> = {
    EUR_USD: { bid: 1.1, ask: 1.1002, time: '2026-09-13T00:00:00Z', tradeable: true, stale: false, fetchedAtMs: 1000, baseline: 1.1 },
  }
  const result = mergeForexPrices(current, {
    EUR_USD: { bid: 1.25, ask: 1.2502, time: '2026-09-13T00:00:05Z', tradeable: true, stale: false, fetchedAtMs: 2000 },
  })
  assert.equal(result.EUR_USD.baseline, 1.1)
  assert.equal(result.EUR_USD.bid, 1.25)
})

test('mergeForexPrices retries capturing the baseline if the first-seen bid was null', () => {
  const current: Record<string, ForexPriceEntry> = {
    EUR_USD: { bid: null, ask: null, time: null, tradeable: false, stale: false, fetchedAtMs: 1000, baseline: null },
  }
  const result = mergeForexPrices(current, {
    EUR_USD: { bid: 1.12, ask: 1.1202, time: '2026-09-13T00:00:05Z', tradeable: true, stale: false, fetchedAtMs: 2000 },
  })
  assert.equal(result.EUR_USD.baseline, 1.12)
})

test('startForexPolling reschedules after onUpdate throws', async () => {
  const originalFetch = globalThis.fetch
  let callCount = 0
  const fetchMock = mock.fn(async () => {
    callCount++
    return {
      ok: true,
      json: async () => ({ prices: {} }),
    } as Response
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  let updateCount = 0
  const stop = startForexPolling(() => {
    updateCount++
    if (updateCount === 1) throw new Error('boom')
  }, 20)

  try {
    // Give the poller time to hit the first (throwing) update and reschedule
    // for at least one more tick.
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.ok(callCount >= 2, `expected at least 2 fetch calls, got ${callCount}`)
  } finally {
    stop()
    globalThis.fetch = originalFetch
  }
})
