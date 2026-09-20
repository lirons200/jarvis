import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const BRIDGE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(BRIDGE, '..')

/** JARVIS_* variables that are intentionally NOT in .env.example. Add a reason for each. */
const UNDOCUMENTED_ON_PURPOSE = new Set([
  // (none today) e.g. 'JARVIS_INTERNAL_X' — set by scripts/start.mjs for the bridge, not a user setting
])

// process.env.JARVIS_X and process.env['JARVIS_X'] / ["JARVIS_X"]
const READ_RE = /process\.env(?:\.|\[\s*['"])(JARVIS_[A-Z0-9_]+)/g

const sources = readdirSync(BRIDGE).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'))

function variablesRead() {
  const found = new Map()
  for (const file of sources) {
    for (const m of readFileSync(join(BRIDGE, file), 'utf8').matchAll(READ_RE)) {
      found.set(m[1], file)
    }
  }
  return found
}

test('the scan actually finds variables (guards against a broken regex)', () => {
  const found = variablesRead()
  assert.ok(sources.length > 5)
  for (const known of ['JARVIS_BRIDGE_PORT', 'JARVIS_TRADING_ARM', 'JARVIS_OANDA_ALLOW_LIVE']) {
    assert.ok(found.has(known), `expected the scan to find ${known}`)
  }
})

test('every JARVIS_* variable the bridge reads is documented in .env.example', () => {
  const example = readFileSync(join(ROOT, '.env.example'), 'utf8')
  // Documented = appears as a (possibly commented-out) `NAME=` assignment.
  const documented = new Set(
    [...example.matchAll(/^\s*#?\s*(JARVIS_[A-Z0-9_]+)=/gm)].map((m) => m[1]),
  )
  const missing = [...variablesRead()]
    .filter(([name]) => !documented.has(name) && !UNDOCUMENTED_ON_PURPOSE.has(name))
    .map(([name, file]) => `${name} (read in bridge/${file})`)
  assert.deepEqual(missing, [], `add these to .env.example:\n  ${missing.join('\n  ')}`)
})
