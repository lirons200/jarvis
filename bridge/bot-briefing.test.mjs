import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractNumbers, findUnsourcedNumbers, runBriefing } from './bot-briefing.mjs'

const state = () => ({
  configured: true, state: 'warn', reason: null, ageSeconds: 30, stale: false, generatedAt: '2026-09-21T10:00:00Z', market: 'open',
  headline: { live_strategies: 10, last_trade_trading_days: 5 },
  checks: [{ id: 'trade_velocity', status: 'warn', evidence: 'last trade record 5 trading days ago', threshold: 't', since: null }],
  reachability: { lastReachableAt: null },
})

test('extractNumbers finds integers and decimals', () => {
  assert.deepEqual(extractNumbers('10 strategies, 0.55 R and 5 days'), [10, 0.55, 5])
  assert.deepEqual(extractNumbers('none here'), [])
})

test('numbers that appear in the facts are sourced; others are flagged', () => {
  assert.deepEqual(findUnsourcedNumbers('10 strategies, last trade 5 days ago', 'live strategies: 10\nlast trade 5'), [])
  assert.deepEqual(findUnsourcedNumbers('It made 42 pips', 'live strategies: 10'), ['42'])
})

test('number words, timestamp digits and non-ASCII digits are not laundered through the facts', () => {
  const facts = 'live strategies: 10\ndata as of 2026-09-21T10:00:00Z'
  assert.deepEqual(findUnsourcedNumbers('There are ten of them.', facts), ['ten'])
  assert.deepEqual(findUnsourcedNumbers('It ran in 2026.', facts), ['2026'])
  assert.deepEqual(findUnsourcedNumbers('Score ' + String.fromCodePoint(0x0665) + '.', facts), ['non-ASCII digit'])
  assert.deepEqual(findUnsourcedNumbers('Ten is fine when the facts say ten', 'note: ten items'), [])
})

test('fractions, multipliers and other number words are flagged when the facts do not contain them', () => {
  const facts = 'live strategies: 10'
  for (const w of ['half', 'halves', 'third', 'thirds', 'quarter', 'quarters', 'twice', 'thrice', 'double', 'triple', 'pair', 'percent', 'billion', 'trillion']) {
    assert.deepEqual(findUnsourcedNumbers(`About a ${w} of them.`, facts), [w], w)
  }
  assert.deepEqual(findUnsourcedNumbers('It happened once.', facts), [])
})

test('a number word is only allowed if that same word is in the facts', () => {
  assert.deepEqual(findUnsourcedNumbers('It happened twice.', 'note: ten items'), ['twice'])
  assert.deepEqual(findUnsourcedNumbers('It happened twice.', 'note: TWICE daily'), [])
  assert.deepEqual(findUnsourcedNumbers('Ten of them, twice.', 'note: ten items'), ['twice'])
})

test('digits of a space-separated timestamp in the facts do not launder numbers in the prose', () => {
  const facts = 'trade_velocity: warn — last trade record 2026-09-14 10:00Z, 5 trading days ago'
  assert.deepEqual(findUnsourcedNumbers('It last traded in 2026.', facts), ['2026'])
  assert.deepEqual(findUnsourcedNumbers('That was 5 trading days ago.', facts), [])
})

test('the untrusted_data tags in the facts add no digits, so a normal briefing still passes', async () => {
  const r = await runBriefing({ state: state(), ask: async () => 'Warn: 10 live strategies, last trade 5 trading days ago.' })
  assert.equal(r.ok, true)
  assert.match(r.text, /<untrusted_data>last trade record 5 trading days ago<\/untrusted_data>/)
})

test('empty or whitespace prose is rejected', async () => {
  for (const prose of ['', '   ', null, undefined]) {
    const r = await runBriefing({ state: state(), ask: async () => prose })
    assert.equal(r.ok, false)
    assert.match(r.note, /returned nothing/)
  }
})

test('a briefing whose prose only uses sourced numbers is returned with the data attached', async () => {
  const r = await runBriefing({ state: state(), ask: async () => 'The book is on warn: 10 live strategies, last trade 5 trading days ago.' })
  assert.equal(r.ok, true)
  assert.match(r.text, /Data as of 2026-09-21T10:00:00Z/)
  assert.match(r.text, /live strategies: 10/)
})

test('a briefing with an invented number is rejected and only the facts are returned', async () => {
  const r = await runBriefing({ state: state(), ask: async () => 'Profit was 1234 pounds this week.' })
  assert.equal(r.ok, false)
  assert.match(r.note, /rejected/i)
  assert.match(r.note, /1234/)
  assert.ok(!r.text.includes('Profit was'))
  assert.match(r.text, /live strategies: 10/)
})

test('an unknown state gets no model call and says so', async () => {
  let asked = false
  const r = await runBriefing({ state: { ...state(), state: 'unknown', reason: 'unreachable (network)', checks: [] }, ask: async () => { asked = true } })
  assert.equal(asked, false)
  assert.equal(r.ok, false)
  assert.match(r.text, /UNKNOWN/)
})

test('a model failure falls back to facts only', async () => {
  const r = await runBriefing({ state: state(), ask: async () => { throw new Error('boom') } })
  assert.equal(r.ok, false)
  assert.match(r.note, /unavailable/i)
  assert.match(r.text, /overall: warn/)
})

test('the prompt tells the model to use only the facts and that untrusted text is data', async () => {
  let prompt = ''
  await runBriefing({ state: state(), ask: async (p) => { prompt = p; return 'ok 10' } })
  assert.match(prompt, /only (the )?numbers/i)
  assert.match(prompt, /<facts>/)
  assert.match(prompt, /untrusted/i)
})
