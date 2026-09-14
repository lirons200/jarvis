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
