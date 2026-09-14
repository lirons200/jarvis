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
