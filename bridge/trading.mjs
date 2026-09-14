/**
 * The trading poller, trade journal, boot reconciliation, and the two
 * trading MCP servers. Everything here orchestrates the pure functions in
 * trading-signal.mjs/trading-risk.mjs and the network calls in
 * trading-orders.mjs — this file owns state (the journal, the halt flag)
 * and timing, not strategy or risk math.
 */

import { mkdir, appendFile, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Per-path write queue. appendFile's append-mode is not guaranteed atomic
 * for concurrent writers on every platform (notably not on Windows, where
 * libuv emulates append via seek-to-EOF + write rather than a single
 * atomic O_APPEND syscall) — serializing writes here is what actually
 * guarantees "one JSON line per call" holds, rather than relying on OS
 * append semantics this bridge has already been run on both platforms.
 */
const writeQueues = new Map()

function queueWrite(path, fn) {
  const prior = writeQueues.get(path) ?? Promise.resolve()
  const next = prior.then(fn, fn) // run fn even if the prior write failed
  writeQueues.set(path, next.catch(() => {})) // never let one failure wedge the queue
  return next
}

/**
 * The durable system of record. A proactive spoken announcement is a
 * convenience layered on top of this — if the browser tab is closed when a
 * trade fires, the journal still has it, which the WebSocket push alone
 * would not guarantee.
 */
export async function appendJournalEntry(path, entry) {
  return queueWrite(path, async () => {
    await mkdir(dirname(path), { recursive: true })
    // `at` is spread AFTER entry so a caller can never override the real
    // append timestamp by coincidentally naming a field `at`.
    const line = JSON.stringify({ ...entry, at: new Date().toISOString() })
    await appendFile(path, line + '\n', 'utf8')
  })
}

/**
 * Most recent `n` journal entries, oldest first (i.e. most recent last).
 * A single unparseable line (e.g. a torn write from before write-queueing
 * existed, or any other corruption) is skipped rather than failing the
 * whole read — a status check must not go blind because of one bad line.
 */
export async function readJournalTail(path, n) {
  let content
  try {
    content = await readFile(path, 'utf8')
  } catch {
    return []
  }
  const lines = content.trim().split('\n').filter(Boolean)
  const parsed = []
  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line))
    } catch {
      // Skip a corrupted line rather than failing the whole tail read.
    }
  }
  return parsed.slice(-n)
}

const DAILY_STATE_PATH = new URL('./data/trading-daily-state.json', import.meta.url).pathname

/**
 * Persists { dayKey, dayStartRealizedPL } so a same-day restart doesn't
 * reset the daily-loss baseline to the current lifetime P&L (which would
 * silently forget losses that happened earlier today, before the
 * restart). Best-effort: a read/write failure here must never crash
 * trading — falling back to an in-memory-only baseline (which resets on
 * every restart) is a safe degradation, not a halt condition.
 */
async function loadDailyState() {
  try {
    const raw = await readFile(DAILY_STATE_PATH, 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

async function saveDailyState(dayKey, dayStartRealizedPL) {
  try {
    await mkdir(dirname(DAILY_STATE_PATH), { recursive: true })
    await writeFile(DAILY_STATE_PATH, JSON.stringify({ dayKey, dayStartRealizedPL }), 'utf8')
  } catch (err) {
    console.error(`[jarvis:trading] could not persist daily P&L baseline: ${err.message}`)
  }
}

/**
 * Run once at boot, before the poller starts, against OANDA's real open
 * positions — never trust an assumption about what should be open. Three
 * findings, each requiring a different response from the caller:
 *   - unexpected: a position for a pair not in JARVIS_TRADING_PAIRS.
 *     Adopted in monitor-only mode by the caller, never re-entered.
 *   - missingStopLoss: a configured pair's position with no confirmed
 *     stop-loss (from a prior fill's tradeId, tracked by the caller in
 *     `hasStopLoss`). Logged as a loud warning requiring manual attention.
 *   - unexpectedShorts: any short exposure at all, since the strategy is
 *     long-only — closeLongPosition would never touch this, so it must be
 *     surfaced rather than silently ignored.
 */
export function reconcileOpenPositions(openPositions, configuredPairs, hasStopLoss) {
  const configured = new Set(configuredPairs)
  const unexpected = []
  const missingStopLoss = []
  const unexpectedShorts = []

  for (const [pair, position] of Object.entries(openPositions)) {
    const hasShort = position.shortUnits !== 0
    const hasLong = position.longUnits !== 0
    if (hasShort) unexpectedShorts.push(pair)
    if (!hasLong && !hasShort) continue

    if (!configured.has(pair)) {
      unexpected.push(pair)
      continue
    }

    if (hasLong && !hasStopLoss[pair]) missingStopLoss.push(pair)
  }

  return { unexpected, missingStopLoss, unexpectedShorts }
}

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { resolveEnv, hostFor, fetchPricingOnce, parsePricingResponse } from './forex.mjs'
import { fetchCandlesOnce } from './backtest.mjs'
import { detectLiveSignal, detectCrossoverDirection } from './trading-signal.mjs'
import { computeATR, checkPositionSize, checkTotalExposure, checkDailyLossHalt, tradingDayKey } from './trading-risk.mjs'
import {
  fetchInstrumentPrecision, fetchOpenPositions, fetchAccountPL,
  placeMarketOrder, closeLongPosition, formatStopPrice, buildClientOrderId,
  fetchOpenTradesStopLossStatus,
} from './trading-orders.mjs'

const JOURNAL_PATH = new URL('./data/trading-journal.jsonl', import.meta.url).pathname

const state = {
  armed: false,
  halted: false,
  haltReason: null,
  polling: false,
  timer: null,
  hasStopLoss: {}, // pair -> boolean, tracked from fill confirmations this run
  onAnnounce: null, // set by initTrading, pushes to the browser
  stopPoller: null,
  dayKey: null,
  dayStartRealizedPL: 0,
}

function haltTrading(reason) {
  state.halted = true
  state.haltReason = reason
  console.error(`[jarvis:trading] HALTED — ${reason}`)
  state.stopPoller?.()
}

async function announce(text) {
  console.log(`[jarvis:trading] ${text}`)
  state.onAnnounce?.(text)
}

/**
 * One sweep across every configured pair. A single lock for the WHOLE
 * sweep, not per-pair — a second tick is skipped entirely if the previous
 * one hasn't finished, matching phase 1's poller philosophy but scoped to
 * the multi-pair unit of work rather than one fetch.
 */
async function pollOnce(config) {
  if (state.polling || state.halted) return
  state.polling = true
  try {
    const nowKey = tradingDayKey(Date.now())
    if (state.dayKey === null) {
      const saved = await loadDailyState()
      if (saved && saved.dayKey === nowKey) {
        state.dayKey = saved.dayKey
        state.dayStartRealizedPL = saved.dayStartRealizedPL
      }
    }
    const { realizedPL, unrealizedPL } = await fetchAccountPL(config)
    if (state.dayKey !== nowKey) {
      // Either the very first tick ever, or a genuine new trading day — reset
      // the baseline to the account's current lifetime realized P&L, so
      // "today's" realized P&L starts counting from zero from this point.
      state.dayKey = nowKey
      state.dayStartRealizedPL = realizedPL
      await saveDailyState(nowKey, realizedPL)
    }
    const dailyRealizedPL = realizedPL - state.dayStartRealizedPL
    if (checkDailyLossHalt(dailyRealizedPL, unrealizedPL, config.maxDailyLoss)) {
      haltTrading(`daily loss cap reached (today's realized ${dailyRealizedPL.toFixed(2)} + unrealized ${unrealizedPL.toFixed(2)})`)
      return
    }

    for (const pair of config.pairs) {
      const candles = await fetchCandlesOnce({ ...config, pair })
      if (candles.length < config.slowPeriod + 1) continue

      // Only touch OANDA's real position state when there's a candidate
      // signal — avoids an API call on every pair on every tick when
      // nothing changed.
      const direction = detectCrossoverDirection(candles, config)
      if (direction === 'none') continue

      const openPositions = await fetchOpenPositions(config)
      const currentPosition = openPositions[pair]?.longUnits > 0 ? openPositions[pair] : null
      const signal = detectLiveSignal(candles, currentPosition, config)
      if (signal === 'none') continue

      if (signal === 'enter') {
        const totalOpenUnits = Object.values(openPositions).reduce((sum, p) => sum + p.longUnits, 0)
        if (!checkPositionSize(config.maxPositionUnits, config.maxPositionUnits)) continue
        if (!checkTotalExposure(totalOpenUnits, config.maxPositionUnits, config.maxTotalUnits)) {
          await announce(`Skipped a ${pair} entry — it would exceed the total exposure limit.`)
          continue
        }

        let pricing
        try {
          const rawPricing = await fetchPricingOnce({ ...config, pairs: [pair] })
          pricing = parsePricingResponse(rawPricing, Date.now())
        } catch (err) {
          console.error(`[jarvis:trading] could not check market status for ${pair}: ${err.message}`)
          continue
        }
        // Fail closed: require explicit confirmation the market is open. A
        // missing pricing entry means UNVERIFIED, not "tradeable".
        if (pricing[pair]?.tradeable !== true) {
          continue
        }

        const atr = computeATR(candles)
        if (atr === null) continue
        const stopDistance = atr * config.atrStopMultiplier
        const precision = await fetchInstrumentPrecision({ ...config, pair })
        const clientOrderId = buildClientOrderId(pair, candles[candles.length - 1].time)

        const result = await placeMarketOrder({
          ...config, pair,
          units: config.maxPositionUnits,
          stopLossDistance: formatStopPrice(stopDistance, precision),
          clientOrderId,
        })

        await appendJournalEntry(JOURNAL_PATH, { pair, event: 'enter', ...result })
        if (result.filled) {
          // A fill does not by itself confirm the attached stop-loss survived —
          // OANDA can fill the market order while separately rejecting the stop
          // leg (e.g. price moved). Verify against OANDA's own trade state before
          // ever trusting this position is protected.
          // One retry with a short delay before concluding "unprotected" — OANDA
          // creating the fill and the dependent stop-loss order are two separate
          // pieces of state that a follow-up query might observe before both have
          // settled; a single retry cheaply avoids treating that race as a real
          // safety failure while still catching a genuinely rejected stop quickly.
          let confirmed = (await fetchOpenTradesStopLossStatus(config))[pair]?.hasStopLoss === true
          if (!confirmed) {
            await new Promise((resolve) => setTimeout(resolve, 800))
            confirmed = (await fetchOpenTradesStopLossStatus(config))[pair]?.hasStopLoss === true
          }
          state.hasStopLoss[pair] = confirmed
          if (confirmed) {
            await announce(`Opened a ${pair} position, ${config.maxPositionUnits} units.`)
          } else {
            // No naked positions, ever — close it immediately and stop trading
            // rather than leave an unprotected live position open.
            // Halt before attempting the close — halting can't fail, so this
            // guarantees the bot stops even if the close itself throws below.
            haltTrading(`${pair} filled without a confirmed stop-loss — closing immediately`)
            try {
              await closeLongPosition({ ...config, pair })
              await appendJournalEntry(JOURNAL_PATH, { pair, event: 'closed-unprotected' })
            } catch (closeErr) {
              console.error(`[jarvis:trading] CRITICAL — could not close unprotected ${pair} position: ${closeErr.message}. Manual intervention required.`)
              await appendJournalEntry(JOURNAL_PATH, { pair, event: 'close-unprotected-failed', error: closeErr.message })
            }
            return
          }
        } else {
          await announce(`${pair} entry did not fill: ${result.reason}.`)
        }
      } else if (signal === 'exit') {
        const closeResult = await closeLongPosition({ ...config, pair })
        await appendJournalEntry(JOURNAL_PATH, { pair, event: 'exit', result: closeResult })
        delete state.hasStopLoss[pair]
        await announce(`Closed the ${pair} position.`)
      }
    }
  } catch (err) {
    console.error(`[jarvis:trading] sweep failed: ${err.message}`)
  } finally {
    state.polling = false
  }
}

function startPoller(config) {
  const tick = async () => {
    await pollOnce(config)
    // A halt raised INSIDE pollOnce must actually stop the timer: stopPoller
    // already ran (clearing a timer that wasn't armed yet), so re-arming here
    // would silently undo it.
    if (!state.halted) {
      state.timer = setTimeout(tick, config.pollIntervalMs)
    }
  }
  void tick()
  return () => {
    if (state.timer) clearTimeout(state.timer)
  }
}

/**
 * Boot-time setup. Trading only starts if JARVIS_TRADING_ENABLED and
 * JARVIS_TRADING_ARM are both true (checked fresh every boot — the arm
 * flag is never persisted, so a crash-and-restart always comes up
 * halted-equivalent unless the person restarting it explicitly sets this
 * again) and every mandatory risk-limit env var is present.
 */
export async function initTrading(onAnnounce) {
  state.onAnnounce = onAnnounce

  if (process.env.JARVIS_TRADING_ENABLED !== 'true') {
    console.log('[jarvis:trading] disabled — set JARVIS_TRADING_ENABLED=true to enable')
    return null
  }
  if (process.env.JARVIS_TRADING_ARM !== 'true') {
    console.error('[jarvis:trading] disabled — JARVIS_TRADING_ARM=true is required at every boot to trade')
    return null
  }

  const apiKey = process.env.JARVIS_OANDA_API_KEY
  const accountId = process.env.JARVIS_OANDA_ACCOUNT_ID
  const pairsRaw = process.env.JARVIS_TRADING_PAIRS
  const maxPositionUnits = Number(process.env.JARVIS_TRADING_MAX_POSITION_UNITS)
  const maxTotalUnits = Number(process.env.JARVIS_TRADING_MAX_TOTAL_UNITS)
  const maxDailyLoss = Number(process.env.JARVIS_TRADING_MAX_DAILY_LOSS)
  const atrStopMultiplier = Number(process.env.JARVIS_TRADING_ATR_STOP_MULTIPLIER)
  const pollIntervalMs = Number(process.env.JARVIS_TRADING_POLL_INTERVAL_MS)

  const missing = []
  if (!apiKey) missing.push('JARVIS_OANDA_API_KEY')
  if (!accountId) missing.push('JARVIS_OANDA_ACCOUNT_ID')
  if (!pairsRaw) missing.push('JARVIS_TRADING_PAIRS')
  if (!Number.isFinite(maxPositionUnits) || maxPositionUnits <= 0) missing.push('JARVIS_TRADING_MAX_POSITION_UNITS')
  if (!Number.isFinite(maxTotalUnits) || maxTotalUnits <= 0) missing.push('JARVIS_TRADING_MAX_TOTAL_UNITS')
  if (!Number.isFinite(maxDailyLoss) || maxDailyLoss <= 0) missing.push('JARVIS_TRADING_MAX_DAILY_LOSS')
  if (!Number.isFinite(atrStopMultiplier) || atrStopMultiplier <= 0) missing.push('JARVIS_TRADING_ATR_STOP_MULTIPLIER')
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) missing.push('JARVIS_TRADING_POLL_INTERVAL_MS')
  if (missing.length) {
    console.error(`[jarvis:trading] disabled — missing required config: ${missing.join(', ')}`)
    return null
  }

  let env
  try {
    env = resolveEnv()
  } catch (err) {
    console.error(`[jarvis:trading] disabled — ${err.message}`)
    return null
  }

  const config = {
    host: hostFor(env), accountId, apiKey,
    pairs: pairsRaw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
    fastPeriod: 10, slowPeriod: 30,
    maxPositionUnits, maxTotalUnits, maxDailyLoss, atrStopMultiplier, pollIntervalMs,
  }

  const openPositions = await fetchOpenPositions(config)
  const stopLossStatus = await fetchOpenTradesStopLossStatus(config)
  for (const [pair, info] of Object.entries(stopLossStatus)) {
    state.hasStopLoss[pair] = info.hasStopLoss
  }
  const reconciliation = reconcileOpenPositions(openPositions, config.pairs, state.hasStopLoss)
  if (reconciliation.unexpected.length) {
    console.error(`[jarvis:trading] unexpected open positions on boot (adopted, monitor-only): ${reconciliation.unexpected.join(', ')}`)
  }
  if (reconciliation.missingStopLoss.length) {
    console.error(`[jarvis:trading] WARNING — open position(s) with no confirmed stop-loss: ${reconciliation.missingStopLoss.join(', ')}`)
  }
  if (reconciliation.unexpectedShorts.length) {
    console.error(`[jarvis:trading] WARNING — unexpected short exposure (this strategy is long-only): ${reconciliation.unexpectedShorts.join(', ')}`)
  }

  state.armed = true
  console.log(`[jarvis:trading] armed — ${env} — pairs ${config.pairs.join(', ')}`)
  state.stopPoller = startPoller(config)
  return config
}

export function tradingServer() {
  return createSdkMcpServer({
    name: 'jarvis_trading',
    version: '1.0.0',
    instructions: 'Read-only status for the autonomous forex trading loop.',
    tools: [
      tool('trading_status', 'Report whether autonomous trading is armed, halted, and today\'s P&L.', {}, async () => {
        const tail = await readJournalTail(JOURNAL_PATH, 5)
        const lines = [
          state.armed ? (state.halted ? `Halted — ${state.haltReason}` : 'Armed and running') : 'Not armed',
          `Recent activity: ${tail.length ? tail.map((e) => `${e.pair} ${e.event}`).join(', ') : 'none'}`,
        ]
        return { content: [{ type: 'text', text: lines.join('. ') }] }
      }),
    ],
  })
}

export function tradingControlServer() {
  return createSdkMcpServer({
    name: 'jarvis_trading_control',
    version: '1.0.0',
    instructions: 'The trading kill-switch. Always available, regardless of write permissions.',
    tools: [
      tool('trading_halt', 'Immediately stop autonomous trading. Existing stop-losses stay in place.', {}, async () => {
        haltTrading('halted by voice command')
        return { content: [{ type: 'text', text: 'Trading halted. Existing positions keep their stop-losses.' }] }
      }),
    ],
  })
}
