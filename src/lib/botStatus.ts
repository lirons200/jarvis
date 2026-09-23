import { BRIDGE_HTTP_URL } from '../config'

export type BotState = 'ok' | 'warn' | 'crit' | 'unknown'

export type BotStatus = {
  configured: boolean
  state: BotState
  reason: string | null
  ageSeconds: number | null
  stale: boolean
  market: 'open' | 'closed' | 'unknown'
  topIssue: string | null
  lastReachableAt: string | null
  at: string
}

export const CLIENT_STALE_MS = 60_000
const STATES = new Set(['ok', 'warn', 'crit', 'unknown'])
const MARKETS = new Set(['open', 'closed', 'unknown'])

export function parseBotStatus(data: unknown): BotStatus | null {
  if (typeof data !== 'object' || data === null) return null
  const d = data as Record<string, unknown>
  if (typeof d.configured !== 'boolean') return null
  if (typeof d.state !== 'string' || !STATES.has(d.state)) return null
  if (typeof d.market !== 'string' || !MARKETS.has(d.market)) return null
  if (typeof d.at !== 'string') return null
  if (typeof d.stale !== 'boolean') return null
  return {
    configured: d.configured,
    state: d.state as BotState,
    reason: typeof d.reason === 'string' ? d.reason : null,
    ageSeconds: typeof d.ageSeconds === 'number' && Number.isFinite(d.ageSeconds) ? d.ageSeconds : null,
    stale: d.stale,
    market: d.market as BotStatus['market'],
    topIssue: typeof d.topIssue === 'string' ? d.topIssue : null,
    lastReachableAt: typeof d.lastReachableAt === 'string' ? d.lastReachableAt : null,
    at: d.at,
  }
}

/** The bridge's own answer is old (bridge down or wedged). The last state can still
 *  show for at most about 65 seconds (60 s limit plus the 5 s re-check tick); after
 *  that the pill says UNKNOWN. */
export function isClientStale(s: BotStatus, nowMs: number): boolean {
  const t = Date.parse(s.at)
  return !Number.isFinite(t) || nowMs - t > CLIENT_STALE_MS || t - nowMs > CLIENT_STALE_MS
}

export type Pill = { text: string; level: BotState; title: string }

export const MISSING_GRACE_MS = 20_000

/** No status has ever arrived from the bridge. Silent for a short grace period
 *  after page load, then UNKNOWN: a bridge that is down must not look like
 *  "nothing to show". */
export function missingPill(nowMs: number, mountedAtMs: number): Pill | null {
  if (nowMs - mountedAtMs < MISSING_GRACE_MS) return null
  return { text: 'BOT UNKNOWN', level: 'unknown', title: 'no contact with the JARVIS bridge' }
}

export function pill(s: BotStatus, nowMs: number): Pill | null {
  if (!s.configured) return null
  if (isClientStale(s, nowMs)) {
    return { text: 'BOT UNKNOWN', level: 'unknown', title: 'JARVIS lost contact with its own bridge' }
  }
  let title: string
  if (s.state === 'unknown') {
    title = s.reason ?? 'status unknown'
    if (s.lastReachableAt) title += ` (last reached the bot dashboard ${s.lastReachableAt})`
  } else {
    title = s.topIssue ?? `market ${s.market}, data ${s.ageSeconds ?? '?'}s old`
  }
  return { text: `BOT ${s.state.toUpperCase()}`, level: s.state, title }
}

/** DEV-only sample data for `?botFixture=ok|warn|crit|unknown|stale`, so the pill can be
 *  viewed without a bot. Never used outside `import.meta.env.DEV`. */
export function fixtureBotStatus(kind: string, nowMs: number = Date.now()): BotStatus {
  const at = kind === 'stale' ? '2000-01-01T00:00:00.000Z' : new Date(nowMs).toISOString()
  const state: BotState = kind === 'warn' || kind === 'crit' || kind === 'unknown' ? kind : 'ok'
  return {
    configured: true,
    state,
    reason: state === 'unknown' ? 'unreachable (network)' : null,
    ageSeconds: state === 'unknown' ? null : 30,
    stale: false,
    market: 'open',
    topIssue: state === 'warn' ? 'trade_velocity: last trade record 5 trading days ago' : state === 'crit' ? 'sizing_pinned_zero: 10 strategies sized to zero' : null,
    lastReachableAt: state === 'unknown' ? new Date(nowMs - 300_000).toISOString() : null,
    at,
  }
}

export function startBotPolling(onUpdate: (s: BotStatus) => void, intervalMs = 15_000): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const tick = async () => {
    try {
      const res = await fetch(`${BRIDGE_HTTP_URL}/bot/status`, { signal: AbortSignal.timeout(4000) })
      if (res.ok) {
        const s = parseBotStatus(await res.json())
        if (s) onUpdate(s)
      }
    } catch {
      // Bridge unreachable: keep the last snapshot; pill() turns it into UNKNOWN once it is stale.
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
