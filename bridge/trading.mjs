/**
 * The trading poller, trade journal, boot reconciliation, and the two
 * trading MCP servers. Everything here orchestrates the pure functions in
 * trading-signal.mjs/trading-risk.mjs and the network calls in
 * trading-orders.mjs — this file owns state (the journal, the halt flag)
 * and timing, not strategy or risk math.
 */

import { mkdir, appendFile, readFile } from 'node:fs/promises'
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
