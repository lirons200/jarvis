/**
 * Forex backtesting — historical OANDA candles, a moving-average-crossover
 * strategy, and stats, shared by the backtest_run MCP tool and
 * scripts/backtest.mjs. Pure/testable logic is kept separate from the one
 * network call, the same split bridge/forex.mjs uses.
 */

import { openRemote, vetTarget, PROXY_UA } from './net.mjs'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { resolveEnv, hostFor } from './forex.mjs'

/**
 * Parses one `/v3/instruments/{pair}/candles` response into a flat OHLC
 * series. Only complete candles are kept — OANDA includes the still-forming
 * current candle in some responses, and a partial bar would corrupt a
 * moving average computed over it.
 */
export function parseCandles(json) {
  return (json?.candles ?? [])
    .filter((c) => c.complete && c.mid)
    .map((c) => ({
      time: c.time,
      open: Number(c.mid.o),
      high: Number(c.mid.h),
      low: Number(c.mid.l),
      close: Number(c.mid.c),
    }))
}

const FETCH_TIMEOUT_MS = 8000
const MAX_RESPONSE_BYTES = 1024 * 1024

async function readJsonBody(res, maxBytes) {
  const chunks = []
  let size = 0
  for await (const chunk of res) {
    size += chunk.length
    if (size > maxBytes) {
      res.destroy()
      throw new Error('oanda response too large')
    }
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * One candles request. Routed through net.mjs's SSRF-guarded client, same
 * as forex.mjs's fetchPricingOnce — even though OANDA's hosts are fixed, so
 * this can never silently diverge from that convention. `price=M` (mid) is
 * used rather than bid/ask, since this phase doesn't model spread.
 */
export async function fetchCandlesOnce({ host, accountId, apiKey, pair, granularity = 'D', count = 252 }) {
  const clampedCount = Math.min(5000, Math.max(30, Math.round(Number(count) || 252)))
  const url = vetTarget(
    `${host}/v3/instruments/${encodeURIComponent(pair)}/candles` +
      `?granularity=${encodeURIComponent(granularity)}&count=${clampedCount}&price=M`,
  )
  const { res } = await openRemote(
    url,
    {
      'user-agent': PROXY_UA,
      authorization: `Bearer ${apiKey}`,
      accept: 'application/json',
    },
    FETCH_TIMEOUT_MS,
  )
  const status = res.statusCode ?? 0
  if (status !== 200) {
    res.resume()
    const err = new Error(`oanda candles request failed with status ${status}`)
    err.status = status
    throw err
  }
  const json = await readJsonBody(res, MAX_RESPONSE_BYTES)
  return parseCandles(json)
}

export function sma(values, period, index) {
  if (index < period - 1) return null
  let sum = 0
  for (let i = index - period + 1; i <= index; i++) sum += values[i]
  return sum / period
}

/**
 * Long-only, one position at a time. Buys when the fast SMA crosses above
 * the slow SMA, closes when it crosses back below. A buy signal while
 * already positioned is ignored, as is a close signal while flat. An
 * un-closed position at the end of the series is dropped, not reported as
 * a trade — it never realised a P&L.
 *
 * A pure function (candles in, trades out) on purpose, so a second strategy
 * can be added later as a sibling function without touching this one or the
 * engine around it.
 *
 * Precondition: fastPeriod must be less than slowPeriod; validation is the caller's responsibility.
 */
export function movingAverageCrossoverStrategy(candles, { fastPeriod = 10, slowPeriod = 30 } = {}) {
  const closes = candles.map((c) => c.close)
  const trades = []
  let position = null
  let prevFast = null
  let prevSlow = null

  for (let i = 0; i < candles.length; i++) {
    const fast = sma(closes, fastPeriod, i)
    const slow = sma(closes, slowPeriod, i)

    if (fast !== null && slow !== null && prevFast !== null && prevSlow !== null) {
      const crossedUp = prevFast <= prevSlow && fast > slow
      const crossedDown = prevFast >= prevSlow && fast < slow

      if (crossedUp && !position) {
        position = { entryTime: candles[i].time, entryPrice: candles[i].close }
      } else if (crossedDown && position) {
        trades.push({
          entryTime: position.entryTime,
          entryPrice: position.entryPrice,
          exitTime: candles[i].time,
          exitPrice: candles[i].close,
          pnl: candles[i].close - position.entryPrice,
        })
        position = null
      }
    }

    if (fast !== null && slow !== null) {
      prevFast = fast
      prevSlow = slow
    }
  }

  return trades
}

/**
 * RSI (Wilder). The first value is at index `period` (needs `period` price
 * changes): seed avgGain/avgLoss with the simple mean of the first `period`
 * gains/losses, then smooth recursively: avg = (prevAvg * (period - 1) + cur) / period.
 * RSI = 100 - 100 / (1 + avgGain / avgLoss); avgLoss === 0 gives 100, and a
 * completely flat window (no gains or losses) gives 50. Returns an array the
 * same length as `values`, null where undefined.
 */
export function rsiSeries(values, period) {
  const out = new Array(values.length).fill(null)
  if (values.length <= period) return out
  let gain = 0
  let loss = 0
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1]
    if (d > 0) gain += d
    else loss -= d
  }
  let avgGain = gain / period
  let avgLoss = loss / period
  const toRsi = () => (avgLoss === 0 ? (avgGain === 0 ? 50 : 100) : 100 - 100 / (1 + avgGain / avgLoss))
  out[period] = toRsi()
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1]
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period
    out[i] = toRsi()
  }
  return out
}

/** Shared long-only, one-position-at-a-time trade loop for signal-based strategies. */
function runLongOnly(candles, shouldEnter, shouldExit) {
  const trades = []
  let position = null
  for (let i = 0; i < candles.length; i++) {
    if (!position && shouldEnter(i)) {
      position = { entryTime: candles[i].time, entryPrice: candles[i].close }
    } else if (position && shouldExit(i)) {
      trades.push({
        entryTime: position.entryTime,
        entryPrice: position.entryPrice,
        exitTime: candles[i].time,
        exitPrice: candles[i].close,
        pnl: candles[i].close - position.entryPrice,
      })
      position = null
    }
  }
  return trades // an un-closed position at the end is dropped, as in the MA strategy
}

/**
 * RSI mean-reversion, long-only. Buys at the close of a bar whose RSI is
 * below `oversold`; sells at the close of a later bar whose RSI is above
 * `exitLevel`. Signals use only data up to and including the bar's own close.
 * BACKTEST-ONLY: live trading (bridge/trading*.mjs) stays MA-crossover.
 * Precondition: oversold < exitLevel (validated by the caller).
 */
export function rsiMeanReversionStrategy(candles, { period = 14, oversold = 30, exitLevel = 50 } = {}) {
  const rsi = rsiSeries(candles.map((c) => c.close), period)
  return runLongOnly(
    candles,
    (i) => rsi[i] !== null && rsi[i] < oversold,
    (i) => rsi[i] !== null && rsi[i] > exitLevel,
  )
}

/**
 * Donchian-channel breakout, long-only. Buys when the close is above the
 * highest HIGH of the previous `entryPeriod` bars; sells when the close is
 * below the lowest LOW of the previous `exitPeriod` bars. Both channels
 * EXCLUDE the current bar (indices i-N..i-1) — including it would make a
 * close > max(high incl. itself) comparison partly self-referential
 * (lookahead). BACKTEST-ONLY: live trading stays MA-crossover.
 */
export function donchianBreakoutStrategy(candles, { entryPeriod = 20, exitPeriod = 10 } = {}) {
  const highestHigh = (i, n) => {
    let m = -Infinity
    for (let k = i - n; k < i; k++) m = Math.max(m, candles[k].high)
    return m
  }
  const lowestLow = (i, n) => {
    let m = Infinity
    for (let k = i - n; k < i; k++) m = Math.min(m, candles[k].low)
    return m
  }
  return runLongOnly(
    candles,
    (i) => i >= entryPeriod && candles[i].close > highestHigh(i, entryPeriod),
    (i) => i >= exitPeriod && candles[i].close < lowestLow(i, exitPeriod),
  )
}

// ---------------------------------------------------------------------------
// Strategy registry + validation. Params arrive in snake_case (MCP / CLI).
// ---------------------------------------------------------------------------

function intParam(raw, name, min, max, def) {
  if (raw === undefined || raw === null) return def
  const n = Number(raw)
  if (!Number.isInteger(n)) throw new Error(`${name} must be a whole number, got ${JSON.stringify(raw)}.`)
  if (n < min || n > max) throw new Error(`${name} must be between ${min} and ${max}, got ${n}.`)
  return n
}

export const STRATEGIES = {
  ma_crossover: {
    label: 'MA crossover',
    keys: ['fast_period', 'slow_period'],
    // Unchanged legacy behaviour: lenient coercion/clamping rather than rejection.
    validate(raw) {
      const fastPeriod = Math.max(2, Math.round(Number(raw.fast_period) || 10))
      const slowPeriod = Math.max(fastPeriod + 1, Math.round(Number(raw.slow_period) || 30))
      return { fastPeriod, slowPeriod }
    },
    minCandles: (p) => p.slowPeriod,
    describe: (p) => `${p.fastPeriod}/${p.slowPeriod}-day MA crossover`,
    run: movingAverageCrossoverStrategy,
  },
  rsi_mean_reversion: {
    label: 'RSI mean reversion',
    keys: ['rsi_period', 'oversold', 'exit_level'],
    validate(raw) {
      const period = intParam(raw.rsi_period, 'rsi_period', 2, 100, 14)
      const oversold = intParam(raw.oversold, 'oversold', 1, 49, 30)
      const exitLevel = intParam(raw.exit_level, 'exit_level', 2, 99, 50)
      if (exitLevel <= oversold) {
        throw new Error(`exit_level (${exitLevel}) must be greater than oversold (${oversold}).`)
      }
      return { period, oversold, exitLevel }
    },
    minCandles: (p) => p.period + 1,
    describe: (p) => `${p.period}-day RSI mean reversion (buy < ${p.oversold}, sell > ${p.exitLevel})`,
    run: rsiMeanReversionStrategy,
  },
  donchian_breakout: {
    label: 'Donchian breakout',
    keys: ['entry_period', 'exit_period'],
    validate(raw) {
      const entryPeriod = intParam(raw.entry_period, 'entry_period', 2, 200, 20)
      const exitPeriod = intParam(raw.exit_period, 'exit_period', 2, 200, 10)
      return { entryPeriod, exitPeriod }
    },
    minCandles: (p) => Math.max(p.entryPeriod, p.exitPeriod) + 1,
    describe: (p) => `${p.entryPeriod}/${p.exitPeriod}-day Donchian breakout`,
    run: donchianBreakoutStrategy,
  },
}
export const STRATEGY_NAMES = Object.keys(STRATEGIES)
export const DEFAULT_STRATEGY = 'ma_crossover'

/**
 * Validates a strategy name and its params. Returns
 * { name, spec, params } or throws an Error with a user-facing message.
 * A param that belongs to a different strategy is rejected rather than
 * silently ignored. `raw` uses snake_case keys; undefined values are skipped.
 */
export function resolveStrategy(name, raw = {}) {
  const strategy = name === undefined || name === null || name === '' ? DEFAULT_STRATEGY : String(name)
  const spec = Object.hasOwn(STRATEGIES, strategy) ? STRATEGIES[strategy] : null
  if (!spec) throw new Error(`Unknown strategy "${strategy}". Valid strategies: ${STRATEGY_NAMES.join(', ')}.`)
  const allKeys = new Set(Object.values(STRATEGIES).flatMap((s) => s.keys))
  const supplied = Object.entries(raw).filter(([, v]) => v !== undefined && v !== null)
  for (const [k] of supplied) {
    if (!allKeys.has(k)) throw new Error(`Unknown parameter "${k}".`)
    if (!spec.keys.includes(k)) {
      throw new Error(`Parameter "${k}" does not apply to ${strategy} (accepts: ${spec.keys.join(', ')}).`)
    }
  }
  return { name: strategy, spec, params: spec.validate(Object.fromEntries(supplied)) }
}

// ---------------------------------------------------------------------------
// Currency conversion (assumed USD account). Pure functions first, network after.
// ---------------------------------------------------------------------------

/**
 * Scales price-delta P&L by a notional (in BASE-currency units). The result
 * is in the pair's QUOTE currency — only equal to account currency for
 * XXX_USD pairs. Use scaleTradesToUsd for account-currency P&L.
 */
const DEFAULT_NOTIONAL_UNITS = 10000 // a standard "mini lot"

export function scaleTradesToNotional(trades, notionalUnits = DEFAULT_NOTIONAL_UNITS) {
  return trades.map((t) => ({ ...t, pnl: t.pnl * notionalUnits }))
}

/**
 * Which instruments can supply the quote->USD rate for a cross pair,
 * tried in order (Q_USD then USD_Q; which one OANDA lists depends on the
 * currency). rate USD-per-quote = close, or 1/close if invert.
 */
export function conversionCandidates(quote) {
  return [
    { pair: `${quote}_USD`, invert: false },
    { pair: `USD_${quote}`, invert: true },
  ]
}

/** Does this pair need an external rate series to convert to USD? */
export function needsConversionRates(pair) {
  const [base, quote] = pair.split('_')
  return quote !== 'USD' && base !== 'USD'
}

/**
 * Latest rate whose candle time is <= `time` (never a rate from after the
 * exit). Series: [{ time, usdPerQuote }] ascending. Null if none.
 */
export function rateAtTime(series, time) {
  const t = Date.parse(time)
  let found = null
  for (const r of series ?? []) {
    if (Date.parse(r.time) <= t) found = r.usdPerQuote
    else break
  }
  return found
}

/**
 * Converts quote-currency P&L trades to USD.
 *  - XXX_USD: factor 1.
 *  - USD_XXX: pnl / exitPrice (quote units -> USD at the pair's own exit rate).
 *  - crosses: pnl * usdPerQuote at the exit time, from `rateSeries`.
 * All-or-nothing: if any trade's rate can't be determined, NO trade is
 * converted; the result says so via `converted: false` and `warning`, with
 * pnl left in the quote currency. Never silently mixes currencies.
 * Returns { trades, currency, converted, warning }.
 */
export function convertTradesToUsd(quoteTrades, pair, rateSeries = null) {
  const [base, quote] = pair.split('_')
  const fail = (why) => ({
    trades: quoteTrades,
    currency: quote,
    converted: false,
    warning: `P&L is in ${quote}, NOT converted to USD: ${why}. Return % and drawdown % are not meaningful.`,
  })
  let factorFor
  if (quote === 'USD') factorFor = () => 1
  else if (base === 'USD') factorFor = (t) => 1 / t.exitPrice
  else {
    if (!rateSeries?.length) return fail(`no ${quote}/USD rate was available`)
    factorFor = (t) => rateAtTime(rateSeries, t.exitTime)
  }
  const out = []
  for (const t of quoteTrades) {
    const f = factorFor(t)
    if (!(typeof f === 'number' && Number.isFinite(f) && f > 0)) {
      return fail(`no ${quote}/USD rate on or before ${t.exitTime}`)
    }
    out.push({ ...t, pnl: t.pnl * f })
  }
  return { trades: out, currency: 'USD', converted: true, warning: null }
}

/** Notional scaling followed by USD conversion. Pure. */
export function scaleTradesToUsd(trades, pair, { notionalUnits = DEFAULT_NOTIONAL_UNITS, rateSeries = null } = {}) {
  return convertTradesToUsd(scaleTradesToNotional(trades, notionalUnits), pair, rateSeries)
}

/**
 * Network: fetch a quote->USD rate series for a cross pair via
 * fetchCandlesOnce (injectable for tests). Returns [{time, usdPerQuote}] or
 * null if neither Q_USD nor USD_Q could be fetched.
 */
export async function fetchUsdRateSeries(
  { host, accountId, apiKey, quote, granularity = 'D', count = 252 },
  fetchCandles = fetchCandlesOnce,
) {
  for (const { pair, invert } of conversionCandidates(quote)) {
    try {
      const candles = await fetchCandles({ host, accountId, apiKey, pair, granularity, count })
      if (candles?.length) {
        return candles.map((c) => ({ time: c.time, usdPerQuote: invert ? 1 / c.close : c.close }))
      }
    } catch {
      // try the next candidate
    }
  }
  return null
}

/**
 * Shared engine for the MCP tool and CLI: validate -> fetch -> strategy ->
 * USD conversion -> stats. Returns { kind: 'error'|'info', text } for early
 * exits, or { kind: 'ok', ... }. Input validation happens before any network call.
 * `fetchCandles` is injectable so tests never touch the network.
 */
export async function executeBacktest(
  { host, accountId, apiKey, pair, count = 252, strategy, params = {} },
  fetchCandles = fetchCandlesOnce,
) {
  let resolved
  try {
    resolved = resolveStrategy(strategy, params)
  } catch (err) {
    return { kind: 'error', text: err.message }
  }
  const { spec, params: p } = resolved

  let candles
  try {
    candles = await fetchCandles({ host, accountId, apiKey, pair, count })
  } catch (err) {
    return { kind: 'error', text: `Could not fetch historical data for ${pair}: ${err.message}` }
  }
  if (!candles.length) return { kind: 'info', text: `No historical data available for ${pair}.` }

  const description = spec.describe(p)
  if (candles.length < spec.minCandles(p)) {
    return {
      kind: 'info',
      text:
        `Not enough historical data for ${description} — only ${candles.length} ` +
        `candles available (need ${spec.minCandles(p)}). Try a larger count or shorter periods.`,
    }
  }

  const trades = spec.run(candles, p)
  if (!trades.length) {
    return {
      kind: 'info',
      text: `Backtested ${pair} over ${candles.length} daily candles (${description}): 0 trades — no signals in this window.`,
    }
  }

  let rateSeries = null
  if (needsConversionRates(pair)) {
    rateSeries = await fetchUsdRateSeries(
      { host, accountId, apiKey, quote: pair.split('_')[1], count },
      fetchCandles,
    )
  }
  const converted = scaleTradesToUsd(trades, pair, { rateSeries })
  return {
    kind: 'ok',
    pair,
    candleCount: candles.length,
    description,
    trades: converted.trades,
    currency: converted.currency,
    converted: converted.converted,
    warning: converted.warning,
    stats: computeStats(converted.trades),
  }
}

/**
 * Summary performance stats from a completed trade list. Drawdown is
 * tracked against the running peak balance, not the starting balance — a
 * strategy that goes up 20% then down 10% has a 10%-of-peak drawdown, not a
 * misleading "still up overall" figure.
 */
export function computeStats(trades, startingBalance = 10000) {
  let balance = startingBalance
  let peak = startingBalance
  let maxDrawdown = 0
  let wins = 0

  for (const t of trades) {
    balance += t.pnl
    if (balance > peak) peak = balance
    const drawdown = (peak - balance) / peak
    if (drawdown > maxDrawdown) maxDrawdown = drawdown
    if (t.pnl > 0) wins++
  }

  return {
    tradeCount: trades.length,
    totalReturnPct: ((balance - startingBalance) / startingBalance) * 100,
    winRatePct: trades.length ? (wins / trades.length) * 100 : 0,
    maxDrawdownPct: maxDrawdown * 100,
    endingBalance: balance,
  }
}

const PAIR_RE = /^[A-Z]{3}_[A-Z]{3}$/

export function formatTrade(t, i, currency = '') {
  return (
    `${i + 1}. ${t.entryTime.slice(0, 10)} @ ${t.entryPrice.toFixed(5)} -> ` +
    `${t.exitTime.slice(0, 10)} @ ${t.exitPrice.toFixed(5)} ` +
    `(P&L ${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(5)}${currency ? ' ' + currency : ''})`
  )
}

const MAX_TRADES_SHOWN = 50

/**
 * Plain-text report for an executeBacktest 'ok' result. When P&L could not
 * be converted to USD, return/drawdown % are withheld and a warning is shown.
 */
export function formatReport(r) {
  const s = r.stats
  const lines = [
    `Backtested ${r.pair} over ${r.candleCount} daily candles (${r.description}):`,
    `Trades: ${s.tradeCount}`,
    `Win rate: ${s.winRatePct.toFixed(1)}%`,
  ]
  if (r.converted) {
    lines.push(`Total return: ${s.totalReturnPct.toFixed(2)}%`, `Max drawdown: ${s.maxDrawdownPct.toFixed(2)}%`)
    lines.push('P&L currency: USD (assumed USD account, 10,000-unit notional)')
  } else {
    lines.push(`WARNING: ${r.warning}`)
  }
  const omitted = Math.max(0, r.trades.length - MAX_TRADES_SHOWN)
  const shown = r.trades.slice(omitted)
  const header =
    omitted > 0 ? `Trades (showing the most recent ${shown.length} of ${r.trades.length}):` : 'Trades:'
  return `${lines.join('\n')}\n\n${header}\n${shown.map((t, i) => formatTrade(t, i + omitted, r.currency)).join('\n')}`
}

const ok = (text) => ({ content: [{ type: 'text', text }] })
const refuse = (text) => ({ isError: true, content: [{ type: 'text', text }] })

export function backtestServer() {
  return createSdkMcpServer({
    name: 'jarvis_backtest',
    version: '1.0.0',
    instructions:
      'Backtest a strategy (moving-average crossover by default; also RSI mean ' +
      'reversion and Donchian breakout) against OANDA daily history. Returns ' +
      'stats and a trade list as plain text — put the substance on a blade ' +
      'using your own hud-* markup, the same way you would for any other data ' +
      'tool. Backtest-only: live trading remains moving-average crossover.',
    tools: [
      tool(
        'backtest_run',
        'Backtest a strategy on a forex pair using historical OANDA daily ' +
          'candles. strategy is ma_crossover (default), rsi_mean_reversion or ' +
          'donchian_breakout. Reports total return, win rate, max drawdown, ' +
          'trade count and the individual trades, with P&L in USD (assumed USD account).',
        {
          pair: z.string().describe('Instrument name, e.g. EUR_USD, USD_JPY'),
          strategy: z.enum(STRATEGY_NAMES).optional().describe('Strategy, default ma_crossover'),
          fast_period: z.number().optional().describe('ma_crossover: fast MA period in days, default 10'),
          slow_period: z.number().optional().describe('ma_crossover: slow MA period in days, default 30'),
          rsi_period: z.number().optional().describe('rsi_mean_reversion: RSI period 2-100, default 14'),
          oversold: z.number().optional().describe('rsi_mean_reversion: buy below this RSI (1-49), default 30'),
          exit_level: z.number().optional().describe('rsi_mean_reversion: sell above this RSI, default 50'),
          entry_period: z.number().optional().describe('donchian_breakout: entry channel days 2-200, default 20'),
          exit_period: z.number().optional().describe('donchian_breakout: exit channel days 2-200, default 10'),
          count: z.number().optional().describe('Number of daily candles to fetch, default 252 (about one year)'),
        },
        async (args) => {
          const apiKey = process.env.JARVIS_OANDA_API_KEY
          const accountId = process.env.JARVIS_OANDA_ACCOUNT_ID
          if (!apiKey || !accountId) {
            return refuse(
              'Forex backtesting is not configured — set JARVIS_OANDA_API_KEY ' +
                'and JARVIS_OANDA_ACCOUNT_ID to enable it.',
            )
          }

          let env
          try {
            env = resolveEnv()
          } catch (err) {
            return refuse(`Forex backtesting is not configured — ${err.message}`)
          }

          const pair = String(args.pair ?? '').trim().toUpperCase()
          if (!PAIR_RE.test(pair)) {
            return refuse(`"${pair}" isn't a valid instrument name, e.g. EUR_USD.`)
          }

          const { strategy, count, pair: _pair, ...params } = args
          const result = await executeBacktest({
            host: hostFor(env),
            accountId,
            apiKey,
            pair,
            count: Number(count) || 252,
            strategy,
            params,
          })
          if (result.kind === 'error') return refuse(result.text)
          if (result.kind === 'info') return ok(result.text)
          return ok(formatReport(result))
        },
      ),
    ],
  })
}
