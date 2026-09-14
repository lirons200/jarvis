import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendJournalEntry, readJournalTail } from './trading.mjs'

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
