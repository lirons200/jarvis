#!/usr/bin/env node
/**
 * Run a backtest from the command line, independent of JARVIS/voice.
 *
 *   node scripts/backtest.mjs EUR_USD [fastPeriod] [slowPeriod] [count]
 *
 * Shares its engine (candle fetch, strategy, stats) with the backtest_run
 * MCP tool in bridge/backtest.mjs — there is exactly one implementation of
 * the actual backtesting logic.
 */

import {
  fetchCandlesOnce,
  movingAverageCrossoverStrategy,
  computeStats,
  scaleTradesToNotional,
} from '../bridge/backtest.mjs'
import { resolveEnv, hostFor } from '../bridge/forex.mjs'

const PAIR_RE = /^[A-Z]{3}_[A-Z]{3}$/

const [, , pairArg, fastArg, slowArg, countArg] = process.argv
const pair = (pairArg ?? 'EUR_USD').toUpperCase()
const count = Number(countArg) || 252

const apiKey = process.env.JARVIS_OANDA_API_KEY
const accountId = process.env.JARVIS_OANDA_ACCOUNT_ID
if (!apiKey || !accountId) {
  console.error('Set JARVIS_OANDA_API_KEY and JARVIS_OANDA_ACCOUNT_ID to run a backtest.')
  process.exit(1)
}

let env
try {
  env = resolveEnv()
} catch (err) {
  console.error(`Forex backtesting is not configured — ${err.message}`)
  process.exit(1)
}

if (!PAIR_RE.test(pair)) {
  console.error(`"${pair}" isn't a valid instrument name, e.g. EUR_USD.`)
  process.exit(1)
}

let candles
try {
  candles = await fetchCandlesOnce({ host: hostFor(env), accountId, apiKey, pair, count })
} catch (err) {
  console.error(`Could not fetch historical data for ${pair}: ${err.message}`)
  process.exit(1)
}
if (!candles.length) {
  console.error(`No historical data for ${pair}.`)
  process.exit(1)
}

const fastPeriod = Math.max(2, Math.round(Number(fastArg) || 10))
const slowPeriod = Math.max(fastPeriod + 1, Math.round(Number(slowArg) || 30))

if (candles.length < slowPeriod) {
  console.error(
    `Not enough historical data for a ${slowPeriod}-day moving average — ` +
      `only ${candles.length} candles available. Try a larger count or a shorter slow_period.`,
  )
  process.exit(1)
}

const trades = movingAverageCrossoverStrategy(candles, { fastPeriod, slowPeriod })
const scaledTrades = scaleTradesToNotional(trades)
const stats = computeStats(scaledTrades)

console.log(`${pair} — ${candles.length} daily candles, ${fastPeriod}/${slowPeriod}-day MA crossover`)
console.log(`Trades: ${stats.tradeCount}`)
console.log(`Win rate: ${stats.winRatePct.toFixed(1)}%`)
console.log(`Total return: ${stats.totalReturnPct.toFixed(2)}%`)
console.log(`Max drawdown: ${stats.maxDrawdownPct.toFixed(2)}%`)
for (const t of scaledTrades) {
  console.log(
    `  ${t.entryTime.slice(0, 10)} @ ${t.entryPrice.toFixed(5)} -> ` +
      `${t.exitTime.slice(0, 10)} @ ${t.exitPrice.toFixed(5)} ` +
      `(P&L ${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(5)})`,
  )
}
