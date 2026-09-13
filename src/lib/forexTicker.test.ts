import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeDirection, formatRelativeTime, buildDetailHtml } from './forexTicker'

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
