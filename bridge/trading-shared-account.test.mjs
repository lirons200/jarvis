import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  findForeignTrades, ownedTradeIdsFromJournal, shouldRefuseArm, checkSharedAccount,
} from './trading-shared-account.mjs'

const trades = (...t) => ({ trades: t.map(([id, instrument]) => ({ id, instrument })) })
const journal = [{ pair: 'EUR_USD', event: 'enter', filled: true, tradeId: '101' }]
const run = (over) => checkSharedAccount({
  fetchTrades: async () => trades(['101', 'EUR_USD']),
  readJournal: async () => journal,
  ackRaw: undefined,
  ...over,
})

test('ownedTradeIdsFromJournal only takes enter entries with a tradeId', () => {
  const ids = ownedTradeIdsFromJournal([
    { event: 'enter', tradeId: 5 }, { event: 'exit', tradeId: '6' },
    { event: 'enter', tradeId: null }, null, { event: 'enter' },
  ])
  assert.deepEqual([...ids], ['5'])
  assert.equal(ownedTradeIdsFromJournal(undefined).size, 0)
})

test('findForeignTrades: own trades are not foreign, any-pair others are', () => {
  const r = findForeignTrades(trades(['101', 'EUR_USD'], ['202', 'AUD_NZD']), new Set(['101']))
  assert.equal(r.malformed, false)
  assert.deepEqual(r.foreignTrades, [{ id: '202', instrument: 'AUD_NZD' }])
})

test('findForeignTrades: malformed input is flagged, junk entries are foreign', () => {
  for (const bad of [null, undefined, {}, { trades: null }, { trades: 'x' }, { trades: {} }, 5]) {
    assert.equal(findForeignTrades(bad, new Set()).malformed, true)
  }
  const r = findForeignTrades({ trades: [null, {}, 'x', { id: '1' }] }, new Set(['1']))
  assert.equal(r.foreignTrades.length, 3)
})

test('shouldRefuseArm', () => {
  assert.equal(shouldRefuseArm({ foreignTrades: [], ack: false }).refuse, false)
  assert.equal(shouldRefuseArm({ foreignTrades: [{}], ack: false }).refuse, true)
  assert.equal(shouldRefuseArm({ foreignTrades: [{}], ack: true }).refuse, false)
  assert.equal(shouldRefuseArm({ foreignTrades: [{}], ack: 'true' }).refuse, true)
  assert.equal(shouldRefuseArm({ foreignTrades: undefined, ack: true }).refuse, true)
})

test('own trades only: allowed, no warning', async () => {
  const r = await run({})
  assert.equal(r.refuse, false)
  assert.equal(r.warning, null)
})

test('zero trades: allowed', async () => {
  assert.equal((await run({ fetchTrades: async () => ({ trades: [] }) })).refuse, false)
})

test('foreign trade, no ack: refuse with fix guidance', async () => {
  const r = await run({ fetchTrades: async () => trades(['101', 'EUR_USD'], ['9', 'GBP_USD']) })
  assert.equal(r.refuse, true)
  assert.match(r.message, /sub-account/)
  assert.match(r.message, /JARVIS_TRADING_SHARED_ACCOUNT_ACK/)
})

test('ack must be exactly "true"', async () => {
  const f = async () => trades(['9', 'GBP_USD'])
  assert.equal((await run({ fetchTrades: f, ackRaw: 'TRUE' })).refuse, true)
  assert.equal((await run({ fetchTrades: f, ackRaw: '1' })).refuse, true)
  const r = await run({ fetchTrades: f, ackRaw: 'true' })
  assert.equal(r.refuse, false)
  assert.match(r.warning, /1 foreign open trade/)
  assert.match(r.warning, /GBP_USD:1/)
})

test('broker failure: refuse (fail closed), no secrets leaked by helper', async () => {
  const r = await run({ fetchTrades: async () => { throw new Error('boom') }, ackRaw: 'true' })
  assert.equal(r.refuse, true)
  assert.match(r.message, /boom/)
})

test('journal missing or unreadable with trades present: refuse', async () => {
  assert.equal((await run({ readJournal: async () => [] })).refuse, true)
  assert.equal((await run({ readJournal: async () => { throw new Error('EIO') } })).refuse, true)
})

test('hostile OANDA JSON: refuse, never throw', async () => {
  for (const bad of [null, undefined, {}, { trades: null }, { trades: 'x' }, 42]) {
    const r = await run({ fetchTrades: async () => bad, ackRaw: 'true' })
    assert.equal(r.refuse, true)
  }
  const r = await run({ fetchTrades: async () => ({ trades: [null, { id: null }] }) })
  assert.equal(r.refuse, true)
})
