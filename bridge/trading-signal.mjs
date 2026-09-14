/**
 * Live, incremental signal detection for the moving-average-crossover
 * strategy — deliberately NOT the same function as
 * backtest.mjs's movingAverageCrossoverStrategy, which replays a full
 * candle array from scratch and tracks its own internal notion of "am I in
 * a position". That internal notion can silently diverge from what OANDA
 * actually reports (a rejected order, a manual trade, a restart), which is
 * unacceptable for live trading. This function only ever answers "given
 * the most recent two candles and the position the caller says is
 * currently open (which must always come from a fresh OANDA query, never
 * from memory), what should happen now" — sharing only the SMA math with
 * the backtest engine, not its trade-replay loop.
 */

import { sma } from './backtest.mjs'

/**
 * @param {Array<{close:number}>} candles - ascending by time, most recent last
 * @param {object|null} currentPosition - truthy if a position is currently
 *   open for this pair (per a fresh OANDA query), null/undefined if flat
 * @param {{fastPeriod:number, slowPeriod:number}} params
 * @returns {'enter'|'exit'|'none'}
 */
export function detectLiveSignal(candles, currentPosition, { fastPeriod, slowPeriod }) {
  const n = candles.length
  if (n < slowPeriod + 1) return 'none'

  const closes = candles.map((c) => c.close)
  const fastNow = sma(closes, fastPeriod, n - 1)
  const slowNow = sma(closes, slowPeriod, n - 1)
  const fastPrev = sma(closes, fastPeriod, n - 2)
  const slowPrev = sma(closes, slowPeriod, n - 2)

  if (fastNow === null || slowNow === null || fastPrev === null || slowPrev === null) {
    return 'none'
  }

  const crossedUp = fastPrev <= slowPrev && fastNow > slowNow
  const crossedDown = fastPrev >= slowPrev && fastNow < slowNow

  if (crossedUp && !currentPosition) return 'enter'
  if (crossedDown && currentPosition) return 'exit'
  return 'none'
}
