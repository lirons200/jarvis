import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendJournalEntry, readJournalTail, reconcileOpenPositions } from './trading.mjs'

test('appendJournalEntry writes one JSON line per call', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-journal-'))
  const path = join(dir, 'journal.jsonl')
  await appendJournalEntry(path, { pair: 'EUR_USD', event: 'enter', units: 1000 })
  await appendJournalEntry(path, { pair: 'EUR_USD', event: 'exit', units: 1000 })
  const content = await readFile(path, 'utf8')
  const lines = content.trim().split('\n')
  assert.equal(lines.length, 2)
  const first = JSON.parse(lines[0])
  assert.equal(first.pair, 'EUR_USD')
  assert.equal(first.event, 'enter')
  assert.ok(typeof first.at === 'string') // a timestamp was added
})

test('appendJournalEntry creates the parent directory if missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-journal-'))
  const path = join(dir, 'nested', 'journal.jsonl')
  await appendJournalEntry(path, { pair: 'GBP_USD', event: 'enter', units: 500 })
  const content = await readFile(path, 'utf8')
  assert.equal(JSON.parse(content.trim()).pair, 'GBP_USD')
})

test('readJournalTail returns the last N entries, most recent last', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-journal-'))
  const path = join(dir, 'journal.jsonl')
  for (let i = 0; i < 5; i++) {
    await appendJournalEntry(path, { pair: 'EUR_USD', event: 'enter', units: i })
  }
  const tail = await readJournalTail(path, 3)
  assert.deepEqual(tail.map((e) => e.units), [2, 3, 4])
})

test('readJournalTail returns an empty array if the file does not exist yet', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-journal-'))
  const tail = await readJournalTail(join(dir, 'nope.jsonl'), 5)
  assert.deepEqual(tail, [])
})

test('appendJournalEntry serializes concurrent writes to the same path without corrupting lines', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-journal-'))
  const path = join(dir, 'journal.jsonl')
  await Promise.all(
    Array.from({ length: 20 }, (_, i) => appendJournalEntry(path, { pair: 'EUR_USD', event: 'enter', units: i })),
  )
  const content = await readFile(path, 'utf8')
  const lines = content.trim().split('\n')
  assert.equal(lines.length, 20)
  // Every line must be independently valid JSON — a corrupted/interleaved
  // write would produce a line that fails to parse.
  const parsed = lines.map((l) => JSON.parse(l))
  const units = parsed.map((e) => e.units).sort((a, b) => a - b)
  assert.deepEqual(units, Array.from({ length: 20 }, (_, i) => i))
})

test('appendJournalEntry never lets a caller override the real timestamp', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-journal-'))
  const path = join(dir, 'journal.jsonl')
  await appendJournalEntry(path, { pair: 'EUR_USD', event: 'enter', at: '1999-01-01T00:00:00Z' })
  const content = await readFile(path, 'utf8')
  const entry = JSON.parse(content.trim())
  assert.notEqual(entry.at, '1999-01-01T00:00:00Z')
  assert.ok(new Date(entry.at).getTime() > Date.now() - 60_000) // within the last minute
})

test('reconcileOpenPositions reports no findings when open positions match the configured set exactly', () => {
  const openPositions = { EUR_USD: { longUnits: 1000, shortUnits: 0 } }
  const result = reconcileOpenPositions(openPositions, ['EUR_USD'], { EUR_USD: true })
  assert.deepEqual(result.unexpected, [])
  assert.deepEqual(result.missingStopLoss, [])
})

test('reconcileOpenPositions flags a position for a pair not in the configured list', () => {
  const openPositions = { USD_JPY: { longUnits: 500, shortUnits: 0 } }
  const result = reconcileOpenPositions(openPositions, ['EUR_USD'], { USD_JPY: true })
  assert.deepEqual(result.unexpected, ['USD_JPY'])
})

test('reconcileOpenPositions flags a configured-pair position with no known stop-loss', () => {
  const openPositions = { EUR_USD: { longUnits: 1000, shortUnits: 0 } }
  // hasStopLoss map says false (or the pair is simply absent from it)
  const result = reconcileOpenPositions(openPositions, ['EUR_USD'], {})
  assert.deepEqual(result.missingStopLoss, ['EUR_USD'])
})

test('reconcileOpenPositions flags an unexpected short position regardless of the long-only strategy', () => {
  const openPositions = { EUR_USD: { longUnits: 0, shortUnits: 500 } }
  const result = reconcileOpenPositions(openPositions, ['EUR_USD'], { EUR_USD: true })
  assert.deepEqual(result.unexpectedShorts, ['EUR_USD'])
})

test('reconcileOpenPositions flags a short-only position in an unconfigured pair as both unexpected and unexpectedShorts', () => {
  const openPositions = { EUR_JPY: { longUnits: 0, shortUnits: 500 } }
  const result = reconcileOpenPositions(openPositions, ['EUR_USD'], {})
  assert.deepEqual(result.unexpected, ['EUR_JPY'])
  assert.deepEqual(result.unexpectedShorts, ['EUR_JPY'])
})
