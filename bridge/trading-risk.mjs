/**
 * Risk limits for live trading: volatility-aware stop sizing (ATR) and the
 * mandatory position/exposure/daily-loss checks. All pure functions,
 * operating on values the caller fetched fresh from OANDA — this module
 * never calls OANDA itself.
 */

/**
 * OANDA-standard True Range: the largest of the candle's own high-low
 * range, the gap up from the previous close, and the gap down from it. The
 * first candle in a series has no previous close, so its true range is
 * just its own range.
 */
export function trueRange(candles, i) {
  const c = candles[i]
  if (i === 0) return c.high - c.low
  const prevClose = candles[i - 1].close
  return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose))
}

/**
 * Simple (not Wilder-smoothed) average true range over the last `period`
 * candles. A plain average is chosen over Wilder's smoothing for this
 * phase — it is simpler to reason about and test, and is a defensible
 * first cut; revisit only if live use shows it under/over-reacts.
 */
export function computeATR(candles, period = 14) {
  if (!Number.isInteger(period) || period <= 0) return null
  if (candles.length < period) return null
  let sum = 0
  for (let i = candles.length - period; i < candles.length; i++) {
    sum += trueRange(candles, i)
  }
  const result = sum / period
  return Number.isFinite(result) ? result : null
}

/** Long-only: the stop always sits below entry, by ATR × multiplier. */
export function computeStopLossPrice(entryPrice, atr, multiplier) {
  if (!Number.isFinite(atr) || atr <= 0) {
    throw new Error(`computeStopLossPrice: atr must be a positive finite number, got ${atr}`)
  }
  return entryPrice - atr * multiplier
}

/** Per-trade cap — JARVIS_TRADING_MAX_POSITION_UNITS. */
export function checkPositionSize(units, maxPositionUnits) {
  return units <= maxPositionUnits
}

/**
 * Account-wide cap — JARVIS_TRADING_MAX_TOTAL_UNITS. Correlated pairs
 * (EUR_USD and GBP_USD often move together) mean a per-trade cap alone
 * doesn't bound total risk; this checks the SUM across every currently
 * open position plus the candidate new one.
 */
export function checkTotalExposure(currentTotalUnits, newUnits, maxTotalUnits) {
  return currentTotalUnits + newUnits <= maxTotalUnits
}

/**
 * Both realized and unrealized P&L must be supplied by the caller, read
 * directly from OANDA's own account endpoint — never recomputed locally.
 * A pair-scale price delta fed in here instead of a real account-currency
 * P&L would silently compare the wrong units, which is exactly the bug
 * this function exists to guard against by taking pre-converted numbers.
 */
export function checkDailyLossHalt(realizedPL, unrealizedPL, maxDailyLoss) {
  if (!Number.isFinite(realizedPL) || !Number.isFinite(unrealizedPL)) {
    // Malformed P&L data is exactly the situation this safety gate exists
    // for — fail CLOSED (halt) rather than silently continuing to trade on
    // garbage numbers. The opposite of the entry-gate checks in this file,
    // which correctly fail closed by rejecting (false) on NaN input; here
    // "false" means "don't halt", so the safe direction on bad data is the
    // other way.
    return true
  }
  return realizedPL + unrealizedPL <= -Math.abs(maxDailyLoss)
}
