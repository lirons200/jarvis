#!/usr/bin/env node
/**
 * Run a backtest from the command line, independent of JARVIS/voice.
 *
 *   node scripts/backtest.mjs EUR_USD [fastPeriod] [slowPeriod] [count]
 *   node scripts/backtest.mjs USD_JPY --strategy=rsi_mean_reversion [--rsi_period=14] [--oversold=30] [--exit_level=50] [--count=252]
 *   node scripts/backtest.mjs EUR_USD --strategy=donchian_breakout [--entry_period=20] [--exit_period=10]
 *
 * Strategies: ma_crossover (default), rsi_mean_reversion, donchian_breakout.
 * Backtest-only — live trading (bridge/trading*.mjs) stays MA-crossover.
 * P&L is reported in USD (assumed USD account).
 *
 * Shares its engine with the backtest_run MCP tool in bridge/backtest.mjs —
 * there is exactly one implementation of the actual backtesting logic.
 */

import { executeBacktest, formatReport } from '../bridge/backtest.mjs'
import { resolveEnv, hostFor } from '../bridge/forex.mjs'

const PAIR_RE = /^[A-Z]{3}_[A-Z]{3}$/

const positional = []
const flags = {}
for (const arg of process.argv.slice(2)) {
  const m = /^--([a-z_]+)=(.*)$/.exec(arg)
  if (m) flags[m[1]] = m[2]
  else positional.push(arg)
}
const [pairArg, fastArg, slowArg, countArg] = positional
const pair = (pairArg ?? 'EUR_USD').toUpperCase()
const { strategy, count: countFlag, ...paramFlags } = flags
const count = Number(countFlag ?? countArg) || 252

// Flag values are passed through as strings; resolveStrategy validates them.
const params = { ...paramFlags }
if (fastArg !== undefined) params.fast_period = fastArg
if (slowArg !== undefined) params.slow_period = slowArg

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

const result = await executeBacktest({ host: hostFor(env), accountId, apiKey, pair, count, strategy, params })
if (result.kind === 'error') {
  console.error(result.text)
  process.exit(1)
}
console.log(result.kind === 'info' ? result.text : formatReport(result))
