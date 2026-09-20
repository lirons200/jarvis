/**
 * Shared-account guard. JARVIS's order path is account-wide (ALL-units close,
 * account-wide exposure cap and daily-loss halt) and OANDA practice accounts
 * net, so another system's trades on the same account can be closed or
 * reduced by JARVIS (and vice versa). That cannot be made safe in code; the
 * real fix is a dedicated sub-account. This guard only refuses to arm when
 * the account holds trades JARVIS did not open, unless explicitly acked.
 */

/**
 * Ownership rule: a trade is JARVIS's only if its id appears as a tradeId on
 * a journal `enter` entry. Everything else is foreign, on ANY instrument —
 * not just the configured pairs — because margin, netting and the
 * account-wide exposure cap are affected by every open trade, and a trade on
 * an unconfigured pair still means somebody else is using the account.
 * Deliberately conservative: a lost/truncated journal yields false refusals
 * (fail closed), never a false "owned".
 *
 * Malformed input (non-object, non-array `trades`) cannot be interpreted, so
 * it is reported via `malformed` and the caller must refuse.
 */
export function findForeignTrades(openTradesJson, ownedTradeIds) {
  const trades = openTradesJson?.trades
  if (!Array.isArray(trades)) {
    return { foreignTrades: [], malformed: true }
  }
  const owned = ownedTradeIds instanceof Set ? ownedTradeIds : new Set()
  const foreignTrades = []
  for (const t of trades) {
    const obj = t && typeof t === 'object'
    const id = obj && t.id != null ? String(t.id) : null
    // A trade with no readable id can't be proven ours, so it is foreign.
    if (id !== null && owned.has(id)) continue
    foreignTrades.push({
      id,
      instrument: obj && typeof t.instrument === 'string' ? t.instrument : null,
    })
  }
  return { foreignTrades, malformed: false }
}

/** Trade ids JARVIS itself opened, from journal `enter` entries. */
export function ownedTradeIdsFromJournal(entries) {
  const ids = new Set()
  if (!Array.isArray(entries)) return ids
  for (const e of entries) {
    if (e && e.event === 'enter' && e.tradeId != null && e.tradeId !== '') ids.add(String(e.tradeId))
  }
  return ids
}

export function shouldRefuseArm({ foreignTrades, ack }) {
  if (!Array.isArray(foreignTrades)) {
    return { refuse: true, reason: 'could not determine which open trades are foreign' }
  }
  if (foreignTrades.length === 0) return { refuse: false, reason: null }
  if (ack === true) {
    return { refuse: false, reason: `shared account acknowledged with ${foreignTrades.length} foreign open trade(s)` }
  }
  return {
    refuse: true,
    reason: `account holds ${foreignTrades.length} open trade(s) JARVIS did not open`,
  }
}

const FIX =
  'Use a dedicated OANDA sub-account for JARVIS (recommended), or set ' +
  "JARVIS_TRADING_SHARED_ACCOUNT_ACK=true to accept that JARVIS may close or reduce the other system's trades."

/**
 * Boot-time check. `fetchTrades` returns the raw /openTrades JSON (read-only
 * GET); `readJournal` returns journal entries. Both injected for tests.
 * Returns { refuse, message, warning }. Never throws: a broker or journal
 * failure fails CLOSED, because arming blind is worse than not arming.
 */
export async function checkSharedAccount({ fetchTrades, readJournal, ackRaw }) {
  const ack = ackRaw === 'true'
  let json
  try {
    json = await fetchTrades()
  } catch (err) {
    return {
      refuse: true,
      message: `could not read open trades from OANDA (${err?.message ?? err}); refusing to arm without knowing the account state`,
      warning: null,
    }
  }
  let entries = null
  try {
    entries = await readJournal()
  } catch {
    entries = null // unreadable journal: nothing can be proven owned
  }
  const { foreignTrades, malformed } = findForeignTrades(json, ownedTradeIdsFromJournal(entries))
  if (malformed) {
    return {
      refuse: true,
      message: 'OANDA open-trades response was malformed; refusing to arm without knowing the account state',
      warning: null,
    }
  }
  const decision = shouldRefuseArm({ foreignTrades, ack })
  if (decision.refuse) {
    return { refuse: true, message: `${decision.reason}. ${FIX}`, warning: null }
  }
  if (foreignTrades.length > 0) {
    const byPair = {}
    for (const t of foreignTrades) {
      const k = t.instrument ?? 'unknown'
      byPair[k] = (byPair[k] ?? 0) + 1
    }
    const counts = Object.entries(byPair).map(([p, n]) => `${p}:${n}`).join(', ')
    return {
      refuse: false,
      message: null,
      warning: `SHARED ACCOUNT ACKNOWLEDGED — ${foreignTrades.length} foreign open trade(s) (${counts}). JARVIS's ALL-units close and account-wide caps WILL act on them. A dedicated sub-account is the safe fix.`,
    }
  }
  return { refuse: false, message: null, warning: null }
}
