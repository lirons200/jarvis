import { BRIDGE_HTTP_URL } from '../config'
import { CLIENT_STALE_MS } from './botStatus'

export type EdgeVerdict = 'PROVEN' | 'PROMISING' | 'UNPROVEN' | 'NO_EDGE'
export type BotEdge = {
  configured: boolean
  state: 'ok' | 'unknown'
  reason: string | null
  verdict: EdgeVerdict | null
  ev: number | null
  ci95: [number, number] | null
  backtestN: number | null
  live: { n: number; ev: number | null; status: string } | null
  gateN: number | null
  backtestOnly: boolean | null
  at: string
}

const VERDICTS = new Set(['PROVEN', 'PROMISING', 'UNPROVEN', 'NO_EDGE'])
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Strict parse of the bridge's /bot/edge body; anything off-contract is null (no panel data). */
export function parseBotEdge(data: unknown): BotEdge | null {
  if (typeof data !== 'object' || data === null) return null
  const d = data as Record<string, unknown>
  if (typeof d.configured !== 'boolean' || typeof d.at !== 'string') return null
  if (d.state !== 'ok' && d.state !== 'unknown') return null
  const out: BotEdge = {
    configured: d.configured, state: d.state, reason: typeof d.reason === 'string' ? d.reason : null,
    verdict: null, ev: null, ci95: null, backtestN: null, live: null, gateN: null, backtestOnly: null, at: d.at,
  }
  if (d.state === 'unknown') return out
  const ci = Array.isArray(d.ci95) && d.ci95.length === 2 ? d.ci95.map(num) : null
  const live = d.live as Record<string, unknown> | null
  if (typeof d.verdict !== 'string' || !VERDICTS.has(d.verdict) || num(d.ev) === null || !ci || ci.includes(null)) return null
  if (typeof live !== 'object' || live === null || num(live.n) === null || typeof live.status !== 'string') return null
  if (typeof d.backtestOnly !== 'boolean') return null
  return {
    ...out, verdict: d.verdict as EdgeVerdict, ev: d.ev as number, ci95: ci as [number, number],
    backtestN: num(d.backtestN), live: { n: live.n as number, ev: num(live.ev), status: live.status },
    gateN: num(d.gateN), backtestOnly: d.backtestOnly,
  }
}

const R = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(3)}R`

export type EdgeView = {
  verdict: string
  level: 'proven' | 'promising' | 'unproven' | 'noedge' | 'unknown'
  ev: string
  ci95: string
  live: string
  progress: number
  honesty: string | null
}

/** Display model. Never shows a verdict from a stale or unknown answer. */
export function edgeView(e: BotEdge, nowMs: number): EdgeView | null {
  if (!e.configured) return null
  const t = Date.parse(e.at)
  const stale = !Number.isFinite(t) || Math.abs(nowMs - t) > CLIENT_STALE_MS
  if (stale || e.state !== 'ok' || !e.verdict || e.ev === null || !e.ci95 || !e.live) {
    const why = stale ? 'JARVIS lost contact with its own bridge' : (e.reason ?? 'no data')
    return { verdict: 'UNKNOWN', level: 'unknown', ev: '--', ci95: '--', live: '--', progress: 0, honesty: why }
  }
  const gate = e.gateN === null ? 'gate unknown' : `gate ${e.gateN}`
  return {
    verdict: e.verdict,
    level: e.verdict === 'NO_EDGE' ? 'noedge' : (e.verdict.toLowerCase() as EdgeView['level']),
    ev: R(e.ev),
    ci95: `${R(e.ci95[0])} to ${R(e.ci95[1])}`,
    live: `${e.live.n} of ${gate}`,
    progress: e.gateN ? Math.min(1, e.live.n / e.gateN) : 0,
    honesty: e.backtestOnly ? 'BACKTEST-ONLY: live evidence is insufficient, not proof of a live edge' : null,
  }
}

export function startEdgePolling(onUpdate: (e: BotEdge) => void, intervalMs = 30_000): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const tick = async () => {
    try {
      const res = await fetch(`${BRIDGE_HTTP_URL}/bot/edge`, { signal: AbortSignal.timeout(4000) })
      if (res.ok) {
        const e = parseBotEdge(await res.json())
        if (e) onUpdate(e)
      }
    } catch {
      // Bridge unreachable: keep the last snapshot; edgeView() turns it into UNKNOWN once stale.
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
