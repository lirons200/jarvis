/**
 * Strict sanitizer for the bot's GET /api/edge payload. Same rules as
 * bot-copilot-schema.mjs: anything off-contract becomes `unknown`, free text is
 * cleaned and capped, and unknown keys are never forwarded. Only the portfolio
 * card is kept; per-strategy detail, curves and heatmaps are dropped on purpose.
 */
import { cleanText, parseUtcTimestamp } from './bot-copilot-schema.mjs'

export const VERDICTS = new Set(['PROVEN', 'PROMISING', 'UNPROVEN', 'NO_EDGE'])
const LIVE_STATUSES = new Set(['OK', 'INSUFFICIENT', 'DIVERGING'])
// The endpoint is computed per request, so anything older than this is not "now".
export const EDGE_TTL_S = 300
const FUTURE_TOLERANCE_S = 60
const MAX_REASONS = 6
const MAX_GATES = 100
const GENERATED_RE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) UTC$/

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e6 ? v : null)
const count = (v) => (Number.isInteger(v) && v >= 0 && v <= 10_000_000 ? v : null)

function unknown(reason, extra = {}) {
  return {
    state: 'unknown', reason, ageSeconds: null, generatedAt: null, verdict: null, ev: null, ci95: null,
    backtestN: null, live: null, gateN: null, backtestOnly: null, reasons: [], ...extra,
  }
}

export function sanitizeEdge(json, nowMs) {
  if (!isObj(json)) return unknown('schema mismatch: not an object')
  if (typeof json.error === 'string') return unknown('the bot could not assemble the edge state')
  const m = GENERATED_RE.exec(String(json.generated_at))
  const generatedMs = m ? parseUtcTimestamp(`${m[1]}T${m[2]}Z`) : null
  if (generatedMs === null) return unknown('schema mismatch: bad generated_at')
  const generatedAt = `${m[1]}T${m[2]}Z`
  const ageSeconds = Math.round((nowMs - generatedMs) / 1000)
  if (ageSeconds < -FUTURE_TOLERANCE_S) return unknown('data timestamp is in the future (clock skew?)', { generatedAt })
  if (ageSeconds > EDGE_TTL_S) return unknown(`stale: data is ${ageSeconds}s old (limit ${EDGE_TTL_S}s)`, { generatedAt, ageSeconds })
  if (!isObj(json.edge_proof)) return unknown('schema mismatch: no edge_proof', { generatedAt })
  if (json.edge_proof.built !== true) return unknown('edge proof not built on the bot yet', { generatedAt })

  const card = json.long_term?.cards?.portfolio
  if (!isObj(card)) return unknown('schema mismatch: no portfolio card', { generatedAt })
  if (typeof card.verdict !== 'string' || !VERDICTS.has(card.verdict)) return unknown('schema mismatch: bad verdict', { generatedAt })
  const ev = num(card.ev)
  const backtestN = count(card.n)
  const ci = Array.isArray(card.ci95) && card.ci95.length === 2 ? card.ci95.map(num) : null
  if (ev === null || backtestN === null || !ci || ci.includes(null)) return unknown('schema mismatch: bad ev, n or ci95', { generatedAt })

  // A missing live block is treated as no live evidence, never as sufficient.
  const rawLive = isObj(card.live) ? card.live : {}
  const liveN = count(rawLive.n) ?? 0
  const live = {
    n: liveN,
    ev: liveN > 0 ? num(rawLive.ev) : null,
    status: LIVE_STATUSES.has(rawLive.status) ? rawLive.status : 'INSUFFICIENT',
  }

  // The bot's portfolio PROVEN gate is the largest per-strategy n_min (edge_proof.py: min_n = max(...)).
  const progress = Array.isArray(json.long_term?.gate_progress) ? json.long_term.gate_progress.slice(0, MAX_GATES) : []
  const gates = progress.map((g) => count(g?.gate_n)).filter((n) => n !== null && n > 0)
  const gateN = gates.length ? Math.max(...gates) : null

  const reasons = (Array.isArray(card.reasons) ? card.reasons.slice(0, MAX_REASONS) : []).map((r) => cleanText(r, 200)).filter(Boolean)
  const backtestOnly = live.status !== 'OK' || (gateN !== null && live.n < gateN)
  return {
    state: 'ok', reason: null, ageSeconds: Math.max(0, ageSeconds), generatedAt, verdict: card.verdict, ev, ci95: ci,
    backtestN, live, gateN, backtestOnly, reasons,
  }
}
