/**
 * The trading poller, trade journal, boot reconciliation, and the two
 * trading MCP servers. Everything here orchestrates the pure functions in
 * trading-signal.mjs/trading-risk.mjs and the network calls in
 * trading-orders.mjs — this file owns state (the journal, the halt flag)
 * and timing, not strategy or risk math.
 */

import { mkdir, appendFile, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

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

// fileURLToPath, never `.pathname` — on Windows `.pathname` yields
// `/C:/...` (a leading slash before the drive letter), which fs cannot open,
// so every journal/daily-state call would throw.
const DAILY_STATE_PATH = fileURLToPath(new URL('./data/trading-daily-state.json', import.meta.url))

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

import { buildTradingSnapshot } from './trading-snapshot.mjs'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { resolveEnv, hostFor, fetchPricingOnce, parsePricingResponse } from './forex.mjs'
import { fetchCandlesOnce } from './backtest.mjs'
import { detectLiveSignal, detectCrossoverDirection } from './trading-signal.mjs'
import { computeATR, checkTotalExposure, checkDailyLossHalt, tradingDayKey } from './trading-risk.mjs'
import {
  fetchInstrumentPrecision, fetchOpenPositions, fetchAccountPL,
  placeMarketOrder, closeLongPosition, formatStopPrice, buildClientOrderId,
  fetchOpenTradesStopLossStatus, fetchOpenTradesRaw,
} from './trading-orders.mjs'
import { checkSharedAccount } from './trading-shared-account.mjs'

const JOURNAL_PATH = fileURLToPath(new URL('./data/trading-journal.jsonl', import.meta.url))

/**
 * Journal writes are observability, never a safety gate. A logging failure
 * must never propagate into (and thereby skip) a safety action, so every
 * call site inside the poller goes through this.
 */
async function journal(entry) {
  try {
    await appendJournalEntry(JOURNAL_PATH, entry)
  } catch (err) {
    console.error(`[jarvis:trading] could not write journal entry (${entry.event}): ${err.message}`)
  }
}

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
  config: null, // stored once armed, so trading_status can report live P&L
  attemptedSignals: {}, // pair -> candle time of the last entry signal acted on
}

function haltTrading(reason) {
  state.halted = true
  state.haltReason = reason
  snapshotCache = { atMs: 0, value: null } // a halt must show on the HUD now, not after the TTL
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
      // A corrupt/non-finite persisted baseline is treated exactly like no
      // saved state at all — never trusted.
      if (saved && saved.dayKey === nowKey && Number.isFinite(saved.dayStartRealizedPL)) {
        state.dayKey = saved.dayKey
        state.dayStartRealizedPL = saved.dayStartRealizedPL
      } else if (saved && saved.dayKey === nowKey) {
        console.warn(`[jarvis:trading] persisted daily P&L baseline for today is not a finite number (${JSON.stringify(saved.dayStartRealizedPL)}) — ignoring it`)
      }
    }
    const { realizedPL, unrealizedPL } = await fetchAccountPL(config)
    if (state.dayKey !== nowKey) {
      // Either the very first tick ever, or a genuine new trading day — reset
      // the baseline to the account's current lifetime realized P&L, so
      // "today's" realized P&L starts counting from zero from this point.
      // A genuine day rollover (we already had today-1's baseline in memory)
      // is expected and needs no warning; starting cold with no baseline for
      // a day that may already be underway does.
      if (state.dayKey === null) {
        console.warn('[jarvis:trading] no persisted daily P&L baseline found — starting today\'s loss tracking from the account\'s current lifetime P&L, which may undercount losses already taken today')
      }
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
      // A halt raised mid-sweep (by trading_halt, or by this loop itself)
      // must stop the sweep — never start another pair after it.
      if (state.halted) break
      // One pair's failure (a network blip on a close, say) must not skip
      // every remaining pair for this tick.
      try {
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

        // A short here is unexpected for a long-only strategy — boot
        // reconciliation already warns loudly about it (reconcileOpenPositions'
        // unexpectedShorts), but a warning at boot doesn't stop a LATER manual
        // short from appearing mid-session. Refuse to open a new long into a
        // pair that already carries short exposure rather than silently
        // proceeding as if the pair were flat.
        if (signal === 'enter' && openPositions[pair]?.shortUnits) {
          console.error(`[jarvis:trading] skipping ${pair} entry — an existing short position was found; this strategy is long-only and will not trade this pair until the short is resolved manually`)
          continue
        }

        if (signal === 'enter') {
          // The strategy runs on daily candles, so one crossover signal persists
          // unchanged for a whole trading day while the poller re-evaluates every
          // pollIntervalMs. Latch per pair on the signal's candle so a failed or
          // blocked entry is attempted (and announced) once, not on every tick.
          // Note: this means an entry blocked by the exposure limit will not retry
          // even if exposure frees up later the same day — it waits for the next
          // day's candle, matching the daily-candle cadence this strategy runs on.
          const signalTime = candles[candles.length - 1].time
          if (state.attemptedSignals[pair] === signalTime) continue

          // Gross exposure — both sides. Only long units are ever opened by
          // this strategy, but an existing manual short still represents
          // real capital at risk and must count toward the cap.
          const totalOpenUnits = Object.values(openPositions).reduce(
            (sum, p) => sum + p.longUnits + Math.abs(p.shortUnits),
            0,
          )
          if (!checkTotalExposure(totalOpenUnits, config.maxPositionUnits, config.maxTotalUnits)) {
            state.attemptedSignals[pair] = signalTime
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
          const clientOrderId = buildClientOrderId(pair, signalTime)

          // A halt can arrive during this pair's own earlier awaits (pricing
          // check, precision fetch). The loop-top check only stops the NEXT
          // pair — this catches the order currently in flight before it goes out.
          if (state.halted) continue

          const result = await placeMarketOrder({
            ...config, pair,
            units: config.maxPositionUnits,
            stopLossDistance: formatStopPrice(stopDistance, precision),
            clientOrderId,
          })

          state.attemptedSignals[pair] = signalTime

          // Safety verification runs BEFORE any journal write. A journal failure
          // is observability lost; skipping stop-loss confirmation would leave a
          // naked live position running.
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
            let confirmed
            try {
              confirmed = (await fetchOpenTradesStopLossStatus(config))[pair]?.hasStopLoss === true
              if (!confirmed) {
                await new Promise((resolve) => setTimeout(resolve, 800))
                confirmed = (await fetchOpenTradesStopLossStatus(config))[pair]?.hasStopLoss === true
              }
            } catch (verifyErr) {
              // A throw here means we genuinely don't know whether the fill is
              // protected — that is exactly as dangerous as a confirmed "no", not
              // something to shrug off to the per-pair catch and keep trading.
              // Treat it identically to an unconfirmed stop-loss so it routes into
              // the same halt-and-close path below.
              console.error(`[jarvis:trading] could not verify stop-loss for ${pair}: ${verifyErr.message} — treating as unprotected`)
              confirmed = false
            }
            state.hasStopLoss[pair] = confirmed
            if (confirmed) {
              await journal({ pair, event: 'enter', ...result, stopLossConfirmed: true })
              await announce(`Opened a ${pair} position, ${config.maxPositionUnits} units.`)
            } else {
              // No naked positions, ever — close it immediately and stop trading
              // rather than leave an unprotected live position open.
              // Halt before attempting the close — halting can't fail, so this
              // guarantees the bot stops even if the close itself throws below.
              haltTrading(`${pair} filled without a confirmed stop-loss — closing immediately`)
              await journal({ pair, event: 'enter', ...result, stopLossConfirmed: false })
              try {
                const closeResult = await closeLongPosition({ ...config, pair })
                if (closeResult.closed) {
                  await journal({ pair, event: 'closed-unprotected' })
                } else {
                  console.error(`[jarvis:trading] CRITICAL — close for unprotected ${pair} position did not confirm: ${closeResult.reason}. Manual intervention required.`)
                  await journal({ pair, event: 'close-unprotected-failed', reason: closeResult.reason })
                }
              } catch (closeErr) {
                console.error(`[jarvis:trading] CRITICAL — could not close unprotected ${pair} position: ${closeErr.message}. Manual intervention required.`)
                await journal({ pair, event: 'close-unprotected-failed', error: closeErr.message })
              }
              return
            }
          } else {
            await journal({ pair, event: 'enter', ...result })
            await announce(`${pair} entry did not fill: ${result.reason}.`)
          }
        } else if (signal === 'exit') {
          // Deliberately NOT latched like entries: an exit must keep being
          // attempted every tick until the position is actually closed.
          const closeResult = await closeLongPosition({ ...config, pair })
          if (closeResult.closed) {
            await journal({ pair, event: 'exit' })
            delete state.hasStopLoss[pair]
            await announce(`Closed the ${pair} position.`)
          } else {
            // Not confirmed — say nothing and change nothing. The next tick
            // will see the same real (still-open) OANDA position and retry
            // the close automatically; a false "Closed" announcement here
            // would be exactly the kind of unconfirmed success the entry
            // path's fill verification exists to avoid.
            console.error(`[jarvis:trading] ${pair} close did not confirm: ${closeResult.reason} — will retry next tick`)
            await journal({ pair, event: 'exit-unconfirmed', reason: closeResult.reason })
          }
        }
      } catch (pairErr) {
        console.error(`[jarvis:trading] ${pair} failed this sweep: ${pairErr.message}`)
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

  // Boot reconciliation talks to OANDA. If OANDA is unreachable this must
  // degrade to "trading disabled", never throw up into server.mjs's
  // top-level await and take the whole bridge (voice, UI) down with it.
  try {
    // Before anything arms: refuse if the account holds trades JARVIS didn't open.
    const guard = await checkSharedAccount({
      fetchTrades: () => fetchOpenTradesRaw(config),
      readJournal: () => readJournalTail(JOURNAL_PATH, Number.MAX_SAFE_INTEGER),
      ackRaw: process.env.JARVIS_TRADING_SHARED_ACCOUNT_ACK,
    })
    if (guard.refuse) {
      console.error(`[jarvis:trading] NOT ARMED — ${guard.message}`)
      return null
    }
    if (guard.warning) console.error(`[jarvis:trading] WARNING — ${guard.warning}`)

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
    state.config = config
    console.log(`[jarvis:trading] armed — ${env} — pairs ${config.pairs.join(', ')}`)
    state.stopPoller = startPoller(config)
    return config
  } catch (err) {
    console.error(`[jarvis:trading] disabled — boot reconciliation against OANDA failed: ${err.message}`)
    state.armed = false
    state.config = null
    return null
  }
}

/**
 * Plain-text status report — armed/halted state, today's P&L against the
 * cap, recent journal activity. Extracted so both the trading_status MCP
 * tool and the Telegram `status` command call this exact same logic,
 * rather than each having their own copy that could drift apart.
 */
export async function getTradingStatusText() {
  const tail = await readJournalTail(JOURNAL_PATH, 5)
  const lines = [
    state.armed ? (state.halted ? `Halted — ${state.haltReason}` : 'Armed and running') : 'Not armed',
  ]
  // dayKey is only set once a pollOnce tick has successfully fetched the
  // account P&L. Before that (right after boot, or for the whole of an
  // OANDA outage) dayStartRealizedPL is still 0, so reporting
  // realizedPL - 0 would present the account's LIFETIME P&L as "today's".
  if (state.armed && state.config && state.dayKey !== null) {
    try {
      const { realizedPL, unrealizedPL } = await fetchAccountPL(state.config)
      const dailyRealizedPL = realizedPL - state.dayStartRealizedPL
      lines.push(`Today's P&L: ${(dailyRealizedPL + unrealizedPL).toFixed(2)} against a ${state.config.maxDailyLoss} loss cap`)
    } catch (err) {
      lines.push(`Could not fetch current P&L: ${err.message}`)
    }
  } else if (state.armed) {
    lines.push("Today's P&L: not yet established")
  }
  lines.push(`Recent activity: ${tail.length ? tail.map((e) => `${e.pair} ${e.event}`).join(', ') : 'none'}`)
  return lines.join('. ')
}

const SNAPSHOT_TTL_MS = 10_000
let snapshotCache = { atMs: 0, value: null }
let snapshotInflight = null

/**
 * Structured, JSON-safe status for the HUD dashboard. Unlike the text
 * report it never includes credentials, account ids, or raw broker
 * payloads. Broker lookups are cached briefly so a polling browser can't
 * turn into a request storm against OANDA. Read-only.
 */
export async function getTradingSnapshot() {
  if (!state.armed || !state.config) return { enabled: false }
  const nowMs = Date.now()
  if (snapshotCache.value && nowMs - snapshotCache.atMs < SNAPSHOT_TTL_MS) return snapshotCache.value
  // Concurrent callers share one broker round-trip.
  snapshotInflight ??= buildSnapshotFromBroker(nowMs).finally(() => { snapshotInflight = null })
  return snapshotInflight
}

/**
 * The broker-reading half of the snapshot, parameterised on its inputs so the
 * read-only verification script (scripts/verify-trading-snapshot.mjs) runs the
 * exact production path against a real account without arming anything.
 * `run` = {armed, halted, haltReason}; `day` = {dayKey, dayStartRealizedPL}.
 */
export async function collectTradingSnapshot({ config, run, day, journalPath = JOURNAL_PATH, nowMs }) {
  const [journalTail, positions, pl, liveStopLoss] = await Promise.all([
    readJournalTail(journalPath, 10),
    fetchOpenPositions(config).catch(() => null),
    fetchAccountPL(config).catch(() => null),
    // In-memory state.hasStopLoss is only written at fill/boot and never
    // re-verified, so the HUD must ask the broker each time.
    fetchOpenTradesStopLossStatus(config).catch(() => null),
  ])
  // Same guard as getTradingStatusText: before dayKey is set the baseline is
  // 0, so realizedPL - 0 would be the account's lifetime P&L, not today's.
  const established = pl !== null && day.dayKey !== null
  return buildTradingSnapshot({
    armed: run.armed,
    halted: run.halted,
    haltReason: run.haltReason,
    pairs: config.pairs,
    openPositions: positions,
    liveStopLoss,
    dailyRealizedPL: established ? pl.realizedPL - day.dayStartRealizedPL : null,
    unrealizedPL: pl ? pl.unrealizedPL : null,
    maxDailyLoss: config.maxDailyLoss,
    journal: journalTail,
    nowMs,
  })
}

async function buildSnapshotFromBroker(nowMs) {
  const value = await collectTradingSnapshot({ config: state.config, run: state, day: state, nowMs })
  // A halt during the fetch clears the cache; don't resurrect a pre-halt value.
  if (!state.halted || value.halted) snapshotCache = { atMs: nowMs, value }
  return value
}

/** GET /trading/status — registered inside server.mjs's origin-checked handler, like forexRoute. */
export async function tradingRoute(req, res, cors) {
  let body
  try {
    body = await getTradingSnapshot()
  } catch {
    // Not {enabled:false}: that would make the panel vanish while armed. A
    // non-200 makes the client keep its last snapshot, which goes visibly STALE.
    res.writeHead(503, { ...cors, 'content-type': 'application/json' })
    return res.end(JSON.stringify({ error: 'snapshot unavailable' }))
  }
  res.writeHead(200, { ...cors, 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/**
 * Halts trading, tagging the log line with who triggered it (`'voice'`,
 * `'telegram'`) — extracted for the same reason as getTradingStatusText,
 * and so a future caller (a scheduled safety check, say) has an obvious
 * place to hook in without duplicating haltTrading's own logic.
 */
export function isTradingHalted() {
  return state.halted
}

export function triggerHalt(source) {
  haltTrading(`halted via ${source}`)
}

export function tradingServer() {
  return createSdkMcpServer({
    name: 'jarvis_trading',
    version: '1.0.0',
    instructions: 'Read-only status for the autonomous forex trading loop.',
    tools: [
      tool('trading_status', 'Report whether autonomous trading is armed, halted, and today\'s P&L.', {}, async () => {
        const text = await getTradingStatusText()
        return { content: [{ type: 'text', text }] }
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
        triggerHalt('voice command')
        return { content: [{ type: 'text', text: 'Trading halted. Existing positions keep their stop-losses.' }] }
      }),
    ],
  })
}
