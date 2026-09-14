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
 * detectCrossoverDirection enforces, rather than merely documents, that
 * fastPeriod < slowPeriod and that the candles it reads are strictly
 * ascending by time — see the guards at the top of the function.
 * detectLiveSignal is a thin position-aware wrapper over it; the raw
 * direction is exported separately so a caller can cheaply detect a
 * candidate EXIT without having to pretend it already knows the position.
 */

import { sma } from './backtest.mjs'

/**
 * Raw crossover direction for the most recent two candles, ignoring
 * position state entirely. Used to cheaply decide whether it's worth
 * querying OANDA's real position before calling detectLiveSignal — unlike
 * detectLiveSignal, this reports 'down' even with no position passed in,
 * which is exactly what a caller needs to detect a candidate EXIT without
 * first assuming nobody is in a trade. (A prior version of this file used
 * detectLiveSignal(candles, null, params) for that pre-check, which could
 * never report a downward crossover — null is falsy, so the exit branch
 * `crossedDown && currentPosition` could never fire. That made every
 * position's own exit signal unreachable; this split fixes it.)
 */
export function detectCrossoverDirection(candles, { fastPeriod, slowPeriod }) {
  const n = candles.length

  if (fastPeriod >= slowPeriod) {
    throw new Error(`detectCrossoverDirection: fastPeriod (${fastPeriod}) must be less than slowPeriod (${slowPeriod})`)
  }
  if (n >= 2 && !(new Date(candles[n - 1].time) > new Date(candles[n - 2].time))) {
    throw new Error('detectCrossoverDirection: candles must be strictly ascending by time')
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
  if (fastPrev <= slowPrev && fastNow > slowNow) return 'up'
  if (fastPrev >= slowPrev && fastNow < slowNow) return 'down'
  return 'none'
}

/**
 * @param {Array<{close:number}>} candles - ascending by time, most recent last
 * @param {object|null} currentPosition - truthy if a position is currently
 *   open for this pair (per a fresh OANDA query), null/undefined if flat
 * @param {{fastPeriod:number, slowPeriod:number}} params
 * @returns {'enter'|'exit'|'none'}
 */
export function detectLiveSignal(candles, currentPosition, params) {
  const direction = detectCrossoverDirection(candles, params)
  if (direction === 'up' && !currentPosition) return 'enter'
  if (direction === 'down' && currentPosition) return 'exit'
  return 'none'
}
