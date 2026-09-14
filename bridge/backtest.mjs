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
