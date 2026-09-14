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

import { fetchCandlesOnce, movingAverageCrossoverStrategy, computeStats } from '../bridge/backtest.mjs'
import { resolveEnv, hostFor } from '../bridge/forex.mjs'

const [, , pairArg, fastArg, slowArg, countArg] = process.argv
const pair = (pairArg ?? 'EUR_USD').toUpperCase()
const fastPeriod = Number(fastArg) || 10
const slowPeriod = Number(slowArg) || 30
const count = Number(countArg) || 252

const apiKey = process.env.JARVIS_OANDA_API_KEY
const accountId = process.env.JARVIS_OANDA_ACCOUNT_ID
if (!apiKey || !accountId) {
  console.error('Set JARVIS_OANDA_API_KEY and JARVIS_OANDA_ACCOUNT_ID to run a backtest.')
  process.exit(1)
}

const env = resolveEnv()
const candles = await fetchCandlesOnce({ host: hostFor(env), accountId, apiKey, pair, count })
if (!candles.length) {
  console.error(`No historical data for ${pair}.`)
  process.exit(1)
}

const trades = movingAverageCrossoverStrategy(candles, { fastPeriod, slowPeriod })
const stats = computeStats(trades)

console.log(`${pair} — ${candles.length} daily candles, ${fastPeriod}/${slowPeriod}-day MA crossover`)
console.log(`Trades: ${stats.tradeCount}`)
console.log(`Win rate: ${stats.winRatePct.toFixed(1)}%`)
console.log(`Total return: ${stats.totalReturnPct.toFixed(2)}%`)
console.log(`Max drawdown: ${stats.maxDrawdownPct.toFixed(2)}%`)
for (const t of trades) {
  console.log(
    `  ${t.entryTime.slice(0, 10)} @ ${t.entryPrice.toFixed(5)} -> ` +
      `${t.exitTime.slice(0, 10)} @ ${t.exitPrice.toFixed(5)} ` +
      `(P&L ${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(5)})`,
  )
}
