/**
 * Pure logic for the forex ticker — direction/formatting helpers and the
 * detail-blade HTML builder. Kept free of React and the store so it can be
 * unit-tested directly; ForexTicker.tsx and store.ts are the only callers.
 * Exception: `startForexPolling` performs I/O (HTTP polling) and is not pure.
 */

import { BRIDGE_HTTP_URL } from '../config'

export type RawPrices = Record<string, Omit<ForexPriceEntry, 'baseline'>>

export type ForexPriceEntry = {
  bid: number | null
  ask: number | null
  time: string | null
  tradeable: boolean
  stale: boolean
  fetchedAtMs: number
  /** First bid seen for this pair this session. null until one arrives. */
  baseline: number | null
}

export type Direction = 'up' | 'down' | 'neutral'

/** Compares the current bid against the session-start baseline. */
export function computeDirection(bid: number | null, baseline: number | null): Direction {
  if (bid === null) return 'neutral'
  if (baseline === null) return 'neutral'
  if (bid > baseline) return 'up'
  if (bid < baseline) return 'down'
  return 'neutral'
}

/** "just now" / "4s ago" / "2m ago" — enough precision for a glanceable chip. */
export function formatRelativeTime(atMs: number, nowMs: number): string {
  const deltaS = Math.max(0, Math.round((nowMs - atMs) / 1000))
  if (deltaS < 3) return 'just now'
  if (deltaS < 60) return `${deltaS}s ago`
  return `${Math.round(deltaS / 60)}m ago`
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Detail-blade body for a clicked chip. Built with only the `hud-*` classes
 * `sanitisePanelHtml` already allows (see src/ui/sanitise.ts) — this passes
 * through the exact same sanitiser as model-authored blades, even though it
 * is generated client-side, so there is exactly one trusted vocabulary for
 * blade markup rather than two.
 */
export function buildDetailHtml(
  pair: string,
  entry: ForexPriceEntry,
  nowMs: number,
): string {
  const bid = entry.bid
  const ask = entry.ask
  const spread = bid !== null && ask !== null ? (ask - bid).toFixed(5) : '—'
  const status = entry.stale
    ? 'stale'
    : entry.tradeable
      ? 'tradeable'
      : 'market closed'
  const changeRow =
    bid !== null && entry.baseline !== null
      ? `<div class="hud-row"><span class="hud-label">Since session start</span>` +
        `<span class="hud-metric">${(((bid - entry.baseline) / entry.baseline) * 100).toFixed(2)}%</span></div>`
      : ''

  return (
    `<div class="hud-rows">` +
    `<div class="hud-row"><span class="hud-label">Pair</span><span class="hud-main">${esc(pair)}</span></div>` +
    `<div class="hud-row"><span class="hud-label">Bid</span><span class="hud-metric">${bid ?? '—'}</span></div>` +
    `<div class="hud-row"><span class="hud-label">Ask</span><span class="hud-metric">${ask ?? '—'}</span></div>` +
    `<div class="hud-row"><span class="hud-label">Spread</span><span class="hud-metric">${spread}</span></div>` +
    changeRow +
    `<div class="hud-row"><span class="hud-label">Last updated</span><span class="hud-sub">${esc(
      formatRelativeTime(entry.fetchedAtMs, nowMs),
    )}</span></div>` +
    `<div class="hud-row"><span class="hud-label">Status</span><span class="hud-tag">${esc(status)}</span></div>` +
    `</div>`
  )
}

/**
 * Polls `GET /forex/prices` on the bridge every `intervalMs` and calls
 * `onUpdate` with the raw cache each time it succeeds. A failed fetch is
 * swallowed — the caller keeps whatever it last had, matching the bridge's
 * own "keep serving the last known price" philosophy. Returns a stop
 * function.
 */
export function startForexPolling(
  onUpdate: (prices: RawPrices) => void,
  intervalMs = 5000,
): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const tick = async () => {
    try {
      const res = await fetch(`${BRIDGE_HTTP_URL}/forex/prices`, {
        signal: AbortSignal.timeout(4000),
      })
      if (res.ok) {
        const data = (await res.json()) as { prices?: RawPrices }
        if (data.prices) onUpdate(data.prices)
      }
    } catch {
      // Bridge unreachable or forex disabled — leave the store as it is.
    } finally {
      if (!stopped) timer = setTimeout(tick, intervalMs)
    }
  }

  void tick()
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}
