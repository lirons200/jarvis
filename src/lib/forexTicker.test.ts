import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { computeDirection, formatRelativeTime, buildDetailHtml } from './forexTicker'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * Extract ALLOWED_CLASSES from sanitise.ts source code to ensure drift detection.
 * This reads the actual source file and parses the Set definition, avoiding import
 * issues with Vite env variables in the test environment.
 */
function parseAllowedClassesFromSource(): Set<string> {
  const sanitisePath = join(__dirname, '../ui/sanitise.ts')
  const source = readFileSync(sanitisePath, 'utf-8')

  // Match the ALLOWED_CLASSES = new Set([...]) definition
  const match = source.match(/export const ALLOWED_CLASSES = new Set\(\[([\s\S]*?)\]\)/)
  if (!match) {
    throw new Error('Could not find ALLOWED_CLASSES definition in sanitise.ts')
  }

  // Extract the class names from the Set definition
  const classesStr = match[1]
  const classMatches = classesStr.match(/'([^']+)'/g)
  if (!classMatches) {
    throw new Error('Could not parse class names from ALLOWED_CLASSES')
  }

  return new Set(classMatches.map(m => m.slice(1, -1)))
}

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
  const allowedClasses = parseAllowedClassesFromSource()

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
