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
 *
 * detectLiveSignal enforces, rather than merely documents, that
 * fastPeriod < slowPeriod and that the candles it reads are strictly
 * ascending by time — see the guards at the top of the function.
 */

import { sma } from './backtest.mjs'

/**
 * @param {Array<{close:number}>} candles - ascending by time, most recent last
 * @param {object|null} currentPosition - truthy if a position is currently
 *   open for this pair (per a fresh OANDA query), null/undefined if flat
 * @param {{fastPeriod:number, slowPeriod:number}} params
 * @returns {'enter'|'exit'|'none'}
 * @throws {Error} if fastPeriod is not less than slowPeriod, or if the
 *   last two candles are not strictly ascending by time (both enforced,
 *   not just assumed)
 */
export function detectLiveSignal(candles, currentPosition, { fastPeriod, slowPeriod }) {
  const n = candles.length

  if (fastPeriod >= slowPeriod) {
    throw new Error(`detectLiveSignal: fastPeriod (${fastPeriod}) must be less than slowPeriod (${slowPeriod})`)
  }

  if (n >= 2 && !(new Date(candles[n - 1].time) > new Date(candles[n - 2].time))) {
    throw new Error('detectLiveSignal: candles must be strictly ascending by time')
  }

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
