/**
 * OANDA order placement/closing for live trading. Pure response-parsing
 * and formatting helpers are exported and tested directly; the network
 * calls that use them are appended in a later step and are not unit-tested
 * (same reasoning as fetchPricingOnce/fetchCandlesOnce — real network
 * calls, verified manually).
 */

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
