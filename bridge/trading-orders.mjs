/**
 * OANDA order placement/closing for live trading. Pure response-parsing
 * and formatting helpers are exported and tested directly; the network
 * calls that use them are appended in a later step and are not unit-tested
 * (same reasoning as fetchPricingOnce/fetchCandlesOnce — real network
 * calls, verified manually).
 */

import { openRemote, vetTarget, PROXY_UA } from './net.mjs'

/**
 * A 200/201 HTTP response from OANDA's order endpoint does NOT mean the
 * order filled — the response body's transaction carries the real
 * outcome. This is the one place that distinction is made; callers must
 * never treat a successful HTTP status alone as "the trade happened".
 */
export function parseOrderResponse(json) {
  const hasFill = Boolean(json?.orderFillTransaction)
  const hasCancel = Boolean(json?.orderCancelTransaction)
  const hasReject = Boolean(json?.orderRejectTransaction)

  if (hasFill && (hasCancel || hasReject)) {
    // Contradictory response — never resolve this in favor of "filled".
    // A confirmed fill must be unambiguous, not just present alongside
    // conflicting evidence.
    return { filled: false, reason: 'ambiguous response (both fill and cancel/reject present)' }
  }
  if (hasFill) {
    const t = json.orderFillTransaction
    return {
      filled: true,
      fillPrice: Number(t.price),
      tradeId: t.tradeOpened?.tradeID ?? null,
    }
  }
  if (hasCancel) {
    return { filled: false, reason: json.orderCancelTransaction.reason ?? 'cancelled' }
  }
  if (hasReject) {
    return { filled: false, reason: json.orderRejectTransaction.rejectReason ?? 'rejected' }
  }
  return { filled: false, reason: 'unknown response shape' }
}

/**
 * OANDA rejects a stop price with the wrong decimal precision for the
 * instrument (JPY pairs: 2-3 decimals; most others: 4-5) — this must be
 * driven by the instrument's real displayPrecision, fetched at call time,
 * never hard-coded per pair.
 */
export function formatStopPrice(price, precision) {
  if (!Number.isFinite(price)) {
    throw new Error(`formatStopPrice: price must be a finite number, got ${price}`)
  }
  return price.toFixed(precision)
}

/**
 * Deterministic per pair+signal so the SAME signal can never produce two
 * accepted orders even if a check-then-act race slips past the in-process
 * lock — OANDA itself rejects a duplicate clientExtensions.id, which is
 * the real backstop, not just the in-memory guard.
 */
export function buildClientOrderId(pair, signalTime) {
  return `jarvis-${pair}-${String(signalTime).slice(0, 10)}`
}

const FETCH_TIMEOUT_MS = 8000
const MAX_RESPONSE_BYTES = 512 * 1024

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

async function oandaRequest({ host, accountId, apiKey, method, path, body }) {
  const url = vetTarget(`${host}/v3/accounts/${encodeURIComponent(accountId)}${path}`)
  const headers = {
    'user-agent': PROXY_UA,
    authorization: `Bearer ${apiKey}`,
    accept: 'application/json',
  }
  if (body) headers['content-type'] = 'application/json'
  const { res } = await openRemote(url, headers, FETCH_TIMEOUT_MS, {
    method,
    body: body ? JSON.stringify(body) : undefined,
  })
  const status = res.statusCode ?? 0
  const json = await readJsonBody(res, MAX_RESPONSE_BYTES)
  // OANDA's order/position endpoints return meaningful error detail in the
  // body even on failure (validation messages, rate-limit reasons) — parsed
  // here so it reaches the error message, not silently dropped the way a
  // caller-side "unknown response shape" fallback would discard it.
  if (status < 200 || status >= 300) {
    const detail = json?.errorMessage ?? json?.rejectReason ?? JSON.stringify(json).slice(0, 200)
    const err = new Error(`oanda request failed with status ${status}: ${detail}`)
    err.status = status
    throw err
  }
  return { status, json }
}

/**
 * displayPrecision for one instrument, e.g. 5 for EUR_USD, 3 for USD_JPY.
 * Fetched fresh rather than hard-coded per pair — see formatStopPrice's
 * comment for why a wrong precision gets an order rejected outright.
 */
export async function fetchInstrumentPrecision({ host, accountId, apiKey, pair }) {
  const { json } = await oandaRequest({
    host, accountId, apiKey, method: 'GET',
    path: `/instruments?instruments=${encodeURIComponent(pair)}`,
  })
  const instrument = json?.instruments?.[0]
  return instrument?.displayPrecision ?? 5
}

/** Every currently open position, keyed by instrument. */
export async function fetchOpenPositions({ host, accountId, apiKey }) {
  const { json } = await oandaRequest({
    host, accountId, apiKey, method: 'GET', path: '/openPositions',
  })
  const out = {}
  for (const p of json?.positions ?? []) {
    const longUnits = Number(p.long?.units ?? 0)
    const shortUnits = Number(p.short?.units ?? 0)
    if (longUnits !== 0 || shortUnits !== 0) out[p.instrument] = { longUnits, shortUnits }
  }
  return out
}

/** Realized + unrealized P&L for the account, in account currency. */
export async function fetchAccountPL({ host, accountId, apiKey }) {
  const { json } = await oandaRequest({ host, accountId, apiKey, method: 'GET', path: '' })
  return {
    unrealizedPL: Number(json?.account?.unrealizedPL ?? 0),
    realizedPL: Number(json?.account?.pl ?? 0),
  }
}

/**
 * Places a long market order with a stop-loss attached. Returns
 * parseOrderResponse's result — callers must check `.filled` before
 * treating the trade as real; see parseOrderResponse's doc comment.
 */
export async function placeMarketOrder({ host, accountId, apiKey, pair, units, stopLossPrice, clientOrderId }) {
  if (!Number.isFinite(units) || units <= 0) {
    throw new Error(`placeMarketOrder: units must be a positive finite number, got ${units}`)
  }
  const { json } = await oandaRequest({
    host, accountId, apiKey, method: 'POST', path: '/orders',
    body: {
      order: {
        type: 'MARKET',
        instrument: pair,
        units: String(Math.abs(Math.round(units))),
        timeInForce: 'FOK',
        positionFill: 'DEFAULT',
        stopLossOnFill: { price: stopLossPrice },
        clientExtensions: { id: clientOrderId },
      },
    },
  })
  return parseOrderResponse(json)
}

/** Closes the entire long position for one instrument. */
export async function closeLongPosition({ host, accountId, apiKey, pair }) {
  const { json } = await oandaRequest({
    host, accountId, apiKey, method: 'PUT',
    path: `/positions/${encodeURIComponent(pair)}/close`,
    body: { longUnits: 'ALL' },
  })
  return json
}
