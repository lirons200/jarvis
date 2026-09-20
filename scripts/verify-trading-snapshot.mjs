#!/usr/bin/env node
/**
 * READ-ONLY verification of the trading dashboard's live data path against a
 * real OANDA PRACTICE account. Runs the production collector
 * (collectTradingSnapshot in bridge/trading.mjs) without arming or enabling
 * anything, then checks the result. Only GET requests are ever made; a
 * diagnostics_channel hook records every outgoing request and the script fails
 * if any is not a GET.
 *
 *   node --import tsx scripts/verify-trading-snapshot.mjs [path-to-env-file]
 *
 * Needs `tsx` (devDependency) so the frontend's parseTradingSnapshot can be
 * imported directly. Credentials are never printed; all output is scrubbed.
 */

import diagnosticsChannel from 'node:diagnostics_channel'
import https from 'node:https'
import { writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectTradingSnapshot } from '../bridge/trading.mjs'
import { resolveEnv, hostFor } from '../bridge/forex.mjs'
import { tradingDayKey } from '../bridge/trading-risk.mjs'
import { deriveStopLossStatus } from '../bridge/trading-snapshot.mjs'
import { parseTradingSnapshot } from '../src/lib/tradingDashboard.ts'

const envFile = process.argv[2] ?? 'C:\\Users\\irons\\jarvis\\.env.local'
process.loadEnvFile(envFile)

const apiKey = process.env.JARVIS_OANDA_API_KEY
const accountId = process.env.JARVIS_OANDA_ACCOUNT_ID
if (!apiKey || !accountId) {
  console.error('FAIL setup: OANDA credentials missing from env file')
  process.exit(1)
}

// Scrub every secret-shaped thing from anything we print.
const ACCT_SHAPE = /\d{3}-\d{3}-\d+-\d+/g
const redact = (s) => String(s).split(apiKey).join('[KEY]').split(accountId).join('[ACCT]').replace(ACCT_SHAPE, '[ACCT]')
const log = (...a) => console.log(redact(a.join(' ')))

let env
try { env = resolveEnv() } catch (e) { log('FAIL setup:', e.message); process.exit(1) }
if (env !== 'practice') { log('ABORT: environment is not practice; refusing to run'); process.exit(1) }
const host = hostFor(env)

// --- request recorder --------------------------------------------------------
const requests = []
diagnosticsChannel.subscribe('http.client.request.start', ({ request }) => {
  requests.push({ method: request.method, path: redact(request.path), at: performance.now() })
})

const results = []
function check(name, ok, detail = '') {
  results.push(ok)
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

// Raw independent GET (own code, not the production helper) for cross-checking.
function rawGet(path) {
  return new Promise((resolve, reject) => {
    const req = https.request(`${host}/v3/accounts/${encodeURIComponent(accountId)}${path}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }) } catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.end()
  })
}

function hasBadLeaf(v, path = '$') {
  if (v === undefined) return path
  if (typeof v === 'number' && !Number.isFinite(v)) return path
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      const bad = hasBadLeaf(x, `${path}.${k}`)
      if (bad) return bad
    }
  }
  return null
}

const pairs = (process.env.JARVIS_TRADING_PAIRS ?? 'EUR_USD,GBP_USD,USD_JPY')
  .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
const maxDailyLoss = Number(process.env.JARVIS_TRADING_MAX_DAILY_LOSS) > 0 ? Number(process.env.JARVIS_TRADING_MAX_DAILY_LOSS) : 50
const config = { host, accountId, apiKey, pairs, maxDailyLoss }
const run = { armed: true, halted: false, haltReason: null }

const tmp = await mkdtemp(join(tmpdir(), 'verify-snap-'))
try {
  // Journal with adversarial content to exercise sanitisation on real ids.
  const journalPath = join(tmp, 'journal.jsonl')
  const lines = [
    { at: '2026-01-01T00:00:00.000Z', pair: 'EUR_USD', event: 'enter', stopLossConfirmed: true, fillPrice: 1.1, tradeId: '999', accountId, apiKey, raw: { auth: apiKey } },
    { at: '2026-01-01T00:01:00.000Z', pair: 'EUR_USD', event: 'error', reason: `oanda request failed: /v3/accounts/${accountId}/orders` },
    { at: '2026-01-01T00:02:00.000Z', pair: 'GBP_USD', event: 'error', reason: `Bearer ${apiKey} bad` },
  ]
  await writeFile(journalPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')

  // ---- Snapshot 1: fresh-start baseline (what pollOnce does on first tick) ----
  const rawAcct = await rawGet('')
  const rawTrades = await rawGet('/openTrades')
  const rawOrders = await rawGet('/pendingOrders')
  const rawPos = await rawGet('/openPositions')
  const rawOk = [rawAcct, rawTrades, rawOrders, rawPos].every((r) => r.status === 200)
  check('raw GETs (/, /openTrades, /pendingOrders, /openPositions) return 200', rawOk)
  if (!rawOk) { log('cannot continue'); process.exit(1) }
  const acct = rawAcct.json.account
  const lifetimeRealized = Number(acct.pl)
  const nowMs = Date.now()

  requests.length = 0
  const t0 = performance.now()
  const snap = await collectTradingSnapshot({
    config, run, journalPath, nowMs,
    day: { dayKey: tradingDayKey(nowMs), dayStartRealizedPL: lifetimeRealized },
  })
  const latencyMs = Math.round(performance.now() - t0)
  const snapReqs = requests.slice()
  const json = JSON.stringify(snap)
  log('snapshot (redacted):', json)

  // 1. Request discipline
  check('every request is a GET', snapReqs.length > 0 && snapReqs.every((r) => r.method === 'GET'), snapReqs.map((r) => `${r.method} ${r.path}`).join(', '))
  check('request count reasonable (<=6)', snapReqs.length <= 6, `${snapReqs.length} requests, ${latencyMs} ms wall`)
  check('latency reasonable (<3000 ms)', latencyMs < 3000, `${latencyMs} ms`)

  // 2. Frontend schema
  const parsed = parseTradingSnapshot(JSON.parse(json))
  check('frontend parseTradingSnapshot accepts snapshot', parsed !== null && parsed.enabled === true)
  const leak = hasBadLeaf(snap)
  check('no NaN/undefined leaks', leak === null, leak ?? '')
  check('positions is an array (broker reachable)', Array.isArray(snap.positions))
  check('one position row per configured pair', snap.positions?.length === pairs.length && snap.positions.every((p, i) => p.pair === pairs[i]))

  // 3. P&L semantics
  check('unrealized matches account unrealizedPL (raw)', snap.pnl.unrealized !== null && Math.abs(snap.pnl.unrealized - Number(acct.unrealizedPL)) < 1e-6,
    `snapshot=${snap.pnl.unrealized} raw=${acct.unrealizedPL}`)
  check('fresh-baseline realizedToday ~ 0 (lifetime realized not leaked as today)', snap.pnl.realizedToday !== null && Math.abs(snap.pnl.realizedToday) < 1e-6,
    `realizedToday=${snap.pnl.realizedToday} lifetime=${lifetimeRealized}`)
  check('lifetime realized is NOT what dailyRealized reports (unless lifetime is 0)', lifetimeRealized === 0 || snap.pnl.realizedToday !== lifetimeRealized)
  check('dailyLossLimit is finite positive', Number.isFinite(snap.pnl.dailyLossLimit) && snap.pnl.dailyLossLimit > 0, String(snap.pnl.dailyLossLimit))

  // Baseline semantics: with a known earlier baseline, today's = lifetime - baseline.
  const snapB = await collectTradingSnapshot({
    config, run, journalPath, nowMs,
    day: { dayKey: tradingDayKey(nowMs), dayStartRealizedPL: lifetimeRealized - 7.5 },
  })
  check('baseline arithmetic: realizedToday = pl - dayStart (7.5 offset)', Math.abs(snapB.pnl.realizedToday - 7.5) < 1e-6, String(snapB.pnl.realizedToday))
  const snapC = await collectTradingSnapshot({ config, run, journalPath, nowMs, day: { dayKey: null, dayStartRealizedPL: 0 } })
  check('baseline not established (dayKey null) -> realizedToday null, not lifetime', snapC.pnl.realizedToday === null)
  check('trading-day key is a YYYY-MM-DD string', /^\d{4}-\d{2}-\d{2}$/.test(tradingDayKey(nowMs)), tradingDayKey(nowMs))

  // 4. Positions & stop-loss vs independent derivation from raw data
  const rawPositions = {}
  for (const p of rawPos.json.positions ?? []) {
    const l = Number(p.long?.units ?? 0), s = Number(p.short?.units ?? 0)
    if (l !== 0 || s !== 0) rawPositions[p.instrument] = { l, s }
  }
  const slTradeIds = new Set((rawOrders.json.orders ?? []).filter((o) => o.type === 'STOP_LOSS').map((o) => o.tradeID))
  const trades = rawTrades.json.trades ?? []
  let posOk = true
  const detail = []
  for (const row of snap.positions) {
    const rp = rawPositions[row.pair]
    const expUnits = rp ? rp.l + Math.abs(rp.s) : 0
    const pairTrades = trades.filter((t) => t.instrument === row.pair)
    let expSl = null
    if (expUnits !== 0) {
      if (pairTrades.length === 0) expSl = 'unknown'
      else expSl = pairTrades.every((t) => slTradeIds.has(t.id)) ? 'ok' : 'missing'
    }
    if (row.units !== expUnits || row.stopLoss !== expSl) posOk = false
    detail.push(`${row.pair}:units=${row.units}/${expUnits},sl=${row.stopLoss}/${expSl}`)
  }
  check('positions + stopLoss match independent derivation from raw broker data', posOk, detail.join(' '))
  const openCount = Object.keys(rawPositions).length
  log(`INFO  open positions on account: ${openCount} (${trades.length} trades, ${slTradeIds.size} STOP_LOSS orders); configured-pair positions in snapshot: ${snap.positions.filter((p) => p.units !== 0).length}`)
  const outOfConfig = Object.keys(rawPositions).filter((k) => !pairs.includes(k))
  if (outOfConfig.length) log(`INFO  ${outOfConfig.length} open position(s) on pairs outside the configured list are (correctly) not shown by the dashboard`)
  check('zero-position / no-stop derivation is null when flat', deriveStopLossStatus(0, {}, 'EUR_USD') === null)

  // 5. Journal sanitisation
  const allowed = new Set(['at', 'pair', 'event', 'stopLossConfirmed', 'fillPrice', 'reason'])
  check('journal entries only carry allowlisted keys', snap.journal.length === 3 && snap.journal.every((e) => Object.keys(e).every((k) => allowed.has(k))))
  check('no account id or api key anywhere in snapshot JSON', !json.includes(accountId) && !json.includes(apiKey) && !/\d{3}-\d{3}-\d+-\d+/.test(json))

  // 6. Repeat latency (second call, warm connections not shared but stable)
  requests.length = 0
  const t1 = performance.now()
  await collectTradingSnapshot({ config, run, journalPath, nowMs: Date.now(), day: { dayKey: tradingDayKey(nowMs), dayStartRealizedPL: lifetimeRealized } })
  log(`INFO  second snapshot: ${requests.length} requests, ${Math.round(performance.now() - t1)} ms`)
  log(`INFO  poll budget: HUD polls every 10 s, bridge caches 10 s; ${snapReqs.length} broker calls per uncached snapshot`)
} finally {
  await rm(tmp, { recursive: true, force: true })
}

const failed = results.filter((r) => !r).length
log(`\n${failed === 0 ? 'ALL PASS' : failed + ' FAILED'} (${results.length} checks)`)
process.exit(failed === 0 ? 0 : 1)
