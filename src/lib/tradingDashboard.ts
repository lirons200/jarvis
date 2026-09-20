/**
 * Pure formatting/selection helpers for the read-only trading panel, plus the
 * status poller (the only impure part). Mirrors forexTicker.ts.
 */

import { BRIDGE_HTTP_URL } from '../config'

export type TradingPosition = {
  pair: string
  units: number
  /** From a live broker check. null = no open position; 'unknown' = check failed. */
  stopLoss: 'ok' | 'missing' | 'unknown' | null
}

export type TradingJournalEntry = {
  at: string | null
  pair: string | null
  event: string
  stopLossConfirmed?: boolean
  fillPrice?: number
  reason?: string
}

export type TradingSnapshot =
  | { enabled: false }
  | {
      enabled: true
      armed: boolean
      halted: boolean
      haltReason: string | null
      /** null = broker unreachable when the snapshot was built. */
      positions: TradingPosition[] | null
      pnl: { realizedToday: number | null; unrealized: number | null; dailyLossLimit: number }
      journal: TradingJournalEntry[]
      at: string
    }

export type TradingState = 'halted' | 'armed' | 'idle'

export function tradingState(s: Extract<TradingSnapshot, { enabled: true }>): TradingState {
  if (s.halted) return 'halted'
  return s.armed ? 'armed' : 'idle'
}

/** Signed money with two decimals; null (unknown) renders as an em dash, never as 0. */
export function formatPnl(n: number | null): string {
  if (n === null) return '—'
  const fixed = Math.abs(n).toFixed(2)
  if (n > 0) return `+${fixed}`
  if (n < 0) return `-${fixed}`
  return fixed
}

/**
 * Fraction of the daily-loss limit consumed (0..1). Only losses count, and
 * realized + unrealized together, matching the bridge's halt check.
 * null when the P&L is unknown or the limit is unusable.
 */
export function lossBudgetUsed(
  pnl: { realizedToday: number | null; unrealized: number | null; dailyLossLimit: number },
): number | null {
  if (pnl.realizedToday === null || pnl.unrealized === null) return null
  if (!(pnl.dailyLossLimit > 0)) return null
  const loss = -(pnl.realizedToday + pnl.unrealized)
  return Math.min(1, Math.max(0, loss / pnl.dailyLossLimit))
}

/** Only pairs with an open position, for a compact panel. */
export function openPositions(s: Extract<TradingSnapshot, { enabled: true }>): TradingPosition[] {
  return (s.positions ?? []).filter((p) => p.units !== 0)
}

/** True when any open position lacks a confirmed stop-loss (missing OR unknown) — the one thing worth alarming over. */
export function hasUnprotectedPosition(s: Extract<TradingSnapshot, { enabled: true }>): boolean {
  return openPositions(s).some((p) => p.stopLoss !== 'ok')
}

export const STALE_AFTER_MS = 30_000

/** A snapshot with an unparseable timestamp is treated as stale: never reassure on data of unknown age. */
export function isSnapshotStale(at: string, nowMs: number, maxAgeMs = STALE_AFTER_MS): boolean {
  const t = Date.parse(at)
  if (!Number.isFinite(t)) return true
  return nowMs - t > maxAgeMs
}

/** Newest first, capped, for display. */
export function recentJournal(entries: TradingJournalEntry[], max = 5): TradingJournalEntry[] {
  return entries.slice(-max).reverse()
}

export function formatJournalLine(e: TradingJournalEntry): string {
  const time = e.at ? e.at.slice(11, 16) : '--:--'
  const pair = e.pair ? e.pair.replace('_', '/') : '—'
  return `${time} ${pair} ${e.event}`
}

/** Runtime guard: the bridge is trusted, but a malformed body must not crash the HUD. */
export function parseTradingSnapshot(data: unknown): TradingSnapshot | null {
  if (typeof data !== 'object' || data === null) return null
  const d = data as Record<string, unknown>
  if (d.enabled === false) return { enabled: false }
  if (d.enabled !== true) return null
  if (typeof d.pnl !== 'object' || d.pnl === null || !Array.isArray(d.journal)) return null
  return data as TradingSnapshot
}

/**
 * Polls `GET /trading/status`. Trading disabled comes back as
 * `{enabled:false}`; an unreachable bridge is swallowed and the store keeps
 * whatever it had. Returns a stop function.
 */
export function startTradingPolling(
  onUpdate: (snap: TradingSnapshot) => void,
  intervalMs = 10_000,
): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const tick = async () => {
    try {
      const res = await fetch(`${BRIDGE_HTTP_URL}/trading/status`, {
        signal: AbortSignal.timeout(4000),
      })
      if (res.ok) {
        const snap = parseTradingSnapshot(await res.json())
        if (snap) onUpdate(snap)
      }
    } catch {
      // Bridge unreachable — keep the last snapshot.
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

/**
 * DEV-ONLY fixture so the panel can be seen without OANDA credentials.
 * Enabled by `?tradingFixture=1` and only when Vite's DEV flag is set, so
 * it is dead code in a production build.
 */
export const FIXTURE_TRADING_SNAPSHOT: TradingSnapshot = {
  enabled: true,
  armed: true,
  halted: false,
  haltReason: null,
  positions: [
    { pair: 'EUR_USD', units: 1000, stopLoss: 'ok' },
    { pair: 'GBP_USD', units: 0, stopLoss: null },
    { pair: 'USD_JPY', units: 500, stopLoss: 'missing' },
  ],
  pnl: { realizedToday: -12.4, unrealized: 3.1, dailyLossLimit: 50 },
  journal: [
    { at: '2026-01-01T08:00:00.000Z', pair: 'EUR_USD', event: 'enter', stopLossConfirmed: true },
    { at: '2026-01-01T09:30:00.000Z', pair: 'GBP_USD', event: 'exit' },
    { at: '2026-01-01T10:15:00.000Z', pair: 'USD_JPY', event: 'enter', stopLossConfirmed: false },
  ],
  at: '2026-01-01T10:16:00.000Z',
}
