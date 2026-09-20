import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Static relative imports reachable from an entry file, as repo-relative posix paths. */
function reachable(entry) {
  const seen = new Set()
  const walk = (file) => {
    const rel = relative(ROOT, file).split('\\').join('/')
    if (seen.has(rel)) return
    seen.add(rel)
    const src = readFileSync(file, 'utf8')
    for (const m of src.matchAll(/(?:from|import\()\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
      walk(resolve(dirname(file), m[1]))
    }
  }
  walk(join(ROOT, entry))
  return [...seen]
}

/** Minimal .dockerignore matcher: enough for the patterns this repo uses. */
function ignored(path, patterns) {
  let result = false
  for (const raw of patterns) {
    const neg = raw.startsWith('!')
    const p = neg ? raw.slice(1) : raw
    const re = new RegExp(
      '^' +
        p
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*\*\//g, '(?:.*/)?')
          .replace(/\*\*/g, '.*')
          .replace(/\*/g, '[^/]*') +
        '(?:/.*)?$',
    )
    if (re.test(path)) result = !neg
  }
  return result
}

test('nothing the bridge needs at runtime is excluded by .dockerignore', () => {
  const patterns = readFileSync(join(ROOT, '.dockerignore'), 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
  const files = [...reachable('bridge/server.mjs'), 'package.json', 'package-lock.json']
  assert.ok(files.includes('bridge/backtest.mjs'), 'import walker should see backtest.mjs')
  const excluded = files.filter((f) => ignored(f, patterns))
  assert.deepEqual(excluded, [])
  // Sanity: the matcher does exclude what it should.
  assert.ok(ignored('.env', patterns))
  assert.ok(ignored('bridge/trading.test.mjs', patterns))
})
