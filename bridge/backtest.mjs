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
    .filter((c) => c.complete)
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
  const url = vetTarget(
    `${host}/v3/instruments/${encodeURIComponent(pair)}/candles` +
      `?granularity=${encodeURIComponent(granularity)}&count=${count}&price=M`,
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

function sma(values, period, index) {
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

function formatTrade(t, i) {
  return (
    `${i + 1}. ${t.entryTime.slice(0, 10)} @ ${t.entryPrice.toFixed(5)} -> ` +
    `${t.exitTime.slice(0, 10)} @ ${t.exitPrice.toFixed(5)} ` +
    `(P&L ${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(5)})`
  )
}

const ok = (text) => ({ content: [{ type: 'text', text }] })
const refuse = (text) => ({ isError: true, content: [{ type: 'text', text }] })

export function backtestServer() {
  return createSdkMcpServer({
    name: 'jarvis_backtest',
    version: '1.0.0',
    instructions:
      'Backtest a moving-average-crossover strategy against a year of OANDA ' +
      'daily history. Returns stats and a trade list as plain text — put the ' +
      'substance on a blade using your own hud-* markup, the same way you ' +
      'would for any other data tool.',
    tools: [
      tool(
        'backtest_run',
        'Backtest a moving-average-crossover strategy on a forex pair using ' +
          'historical OANDA daily candles. Reports total return, win rate, ' +
          'max drawdown, trade count, and the individual trades.',
        {
          pair: z.string().describe('Instrument name, e.g. EUR_USD, GBP_USD'),
          fast_period: z.number().optional().describe('Fast moving-average period in days, default 10'),
          slow_period: z.number().optional().describe('Slow moving-average period in days, default 30'),
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

          const count = Math.min(5000, Math.max(30, Math.round(Number(args.count) || 252)))

          let candles
          try {
            candles = await fetchCandlesOnce({ host: hostFor(env), accountId, apiKey, pair, count })
          } catch (err) {
            return refuse(`Could not fetch historical data for ${pair}: ${err.message}`)
          }
          if (!candles.length) {
            return ok(`No historical data available for ${pair}.`)
          }

          const fastPeriod = Math.max(2, Math.round(Number(args.fast_period) || 10))
          const slowPeriod = Math.max(fastPeriod + 1, Math.round(Number(args.slow_period) || 30))
          const trades = movingAverageCrossoverStrategy(candles, { fastPeriod, slowPeriod })

          if (!trades.length) {
            return ok(
              `Backtested ${pair} over ${candles.length} daily candles ` +
                `(${fastPeriod}/${slowPeriod}-day MA crossover): 0 trades — ` +
                `no crossovers occurred in this window.`,
            )
          }

          const stats = computeStats(trades)
          return ok(
            `Backtested ${pair} over ${candles.length} daily candles ` +
              `(${fastPeriod}/${slowPeriod}-day MA crossover):\n` +
              `Trades: ${stats.tradeCount}\n` +
              `Win rate: ${stats.winRatePct.toFixed(1)}%\n` +
              `Total return: ${stats.totalReturnPct.toFixed(2)}%\n` +
              `Max drawdown: ${stats.maxDrawdownPct.toFixed(2)}%\n\n` +
              `Trades:\n${trades.map(formatTrade).join('\n')}`,
          )
        },
      ),
    ],
  })
}
