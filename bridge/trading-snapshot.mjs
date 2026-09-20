/**
 * Pure builders for the read-only trading dashboard snapshot. No I/O and no
 * access to credentials: trading.mjs gathers the raw numbers and passes only
 * those in, so nothing sensitive can reach the browser through this file.
 */

const MAX_REASON_LEN = 120
// OANDA account ids look like 101-004-1234567-001; error text from the API
// can echo the request path, so scrub anything shaped like one.
const ACCOUNT_ID_RE = /\d{3}-\d{3}-\d+-\d+/g

/** Journal entries carry raw broker results (trade ids, error text). Only an allowlist goes to the browser. */
export function sanitizeJournalEntry(entry) {
  const out = {
    at: typeof entry?.at === 'string' ? entry.at : null,
    pair: typeof entry?.pair === 'string' ? entry.pair : null,
    event: typeof entry?.event === 'string' ? entry.event : 'unknown',
  }
  if (typeof entry?.stopLossConfirmed === 'boolean') out.stopLossConfirmed = entry.stopLossConfirmed
  if (Number.isFinite(entry?.fillPrice)) out.fillPrice = entry.fillPrice
  if (typeof entry?.reason === 'string') {
    out.reason = entry.reason.replace(ACCOUNT_ID_RE, '[redacted]').slice(0, MAX_REASON_LEN)
  }
  return out
}

/** JSON has no NaN; the P&L fail-closed guard produces NaN, so map it to null ("unknown"). */
function finiteOrNull(n) {
  return Number.isFinite(n) ? n : null
}

/**
 * Per-pair stop-loss flag from the live broker check, never from cached
 * memory. 'unknown' (broker check failed or gave no answer for an open
 * position) must never be rendered as protected.
 * @returns {'ok'|'missing'|'unknown'|null} null = no open position
 */
export function deriveStopLossStatus(netUnits, liveStatus, pair) {
  if (netUnits === 0) return null
  if (liveStatus === null || liveStatus === undefined) return 'unknown'
  const live = liveStatus[pair]
  if (!live) return 'unknown'
  return live.hasStopLoss === true ? 'ok' : 'missing'
}

/**
 * @param {object} i
 * @param {boolean} i.armed
 * @param {boolean} i.halted
 * @param {string|null} i.haltReason
 * @param {string[]} i.pairs
 * @param {Record<string,{longUnits:number,shortUnits:number}>|null} i.openPositions null = broker unreachable
 * @param {Record<string,{hasStopLoss:boolean}>|null} i.liveStopLoss null = live check failed
 * @param {number|null} i.dailyRealizedPL null = not yet established / unknown
 * @param {number|null} i.unrealizedPL
 * @param {number} i.maxDailyLoss
 * @param {object[]} i.journal
 * @param {number} i.nowMs
 */
export function buildTradingSnapshot(i) {
  const positions = i.openPositions === null
    ? null
    : i.pairs.map((pair) => {
        const p = i.openPositions[pair]
        const netUnits = p ? p.longUnits + p.shortUnits : 0
        return {
          pair,
          units: netUnits,
          stopLoss: deriveStopLossStatus(netUnits, i.liveStopLoss, pair),
        }
      })

  return {
    enabled: true,
    armed: Boolean(i.armed),
    halted: Boolean(i.halted),
    haltReason: i.halted ? (i.haltReason ?? null) : null,
    positions,
    pnl: {
      realizedToday: finiteOrNull(i.dailyRealizedPL),
      unrealized: finiteOrNull(i.unrealizedPL),
      dailyLossLimit: i.maxDailyLoss,
    },
    journal: i.journal.map(sanitizeJournalEntry),
    at: new Date(i.nowMs).toISOString(),
  }
}
