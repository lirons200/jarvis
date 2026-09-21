/**
 * Strict sanitizer for the bot's GET /api/copilot payload. Anything that does
 * not match the contract becomes `unknown`, never `ok`. Free text is cleaned
 * and capped; unknown keys are never forwarded.
 */
export const STATUS_ORDER = ['ok', 'unknown', 'warn', 'crit']
const RANK = Object.fromEntries(STATUS_ORDER.map((s, i) => [s, i]))
const ID_RE = /^[A-Za-z0-9_.-]{1,40}$/
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/
const MARKETS = new Set(['open', 'closed', 'unknown'])
const MAX_CHECKS = 50
const MAX_TTL_S = 3600
const MAX_TEXT = 120
const FUTURE_TOLERANCE_S = 60
const HEADLINE_KEYS = ['live_strategies', 'last_trade_trading_days']

const isStatus = (v) => typeof v === 'string' && Object.hasOwn(RANK, v)

export function worstOf(statuses) {
  const list = [...statuses]
  if (list.length === 0) return 'unknown'
  return list.reduce((a, b) => (RANK[b] > RANK[a] ? b : a))
}

export function parseUtcTimestamp(s) {
  if (typeof s !== 'string' || !TS_RE.test(s)) return null
  const ms = Date.parse(s)
  if (!Number.isFinite(ms)) return null
  // Date.parse rolls impossible dates over (Feb 31 becomes Mar 3): require a round trip.
  return new Date(ms).toISOString().slice(0, 19) === s.slice(0, 19) ? ms : null
}

// Angle brackets, their look-alikes, zero-width and bidi controls, soft hyphen: inert as
// tags but able to confuse a model reading the text. Built from code points on purpose.
const LOOKALIKE_CODEPOINTS = [0x3c, 0x3e, 0xff1c, 0xff1e, 0x3008, 0x3009, 0x2039, 0x203a, 0x2060, 0xfeff, 0xad]
const LOOKALIKE_RANGES = [[0x200b, 0x200f], [0x202a, 0x202e]]
export function stripLookalikes(s) {
  return Array.from(String(s))
    .filter((ch) => {
      const cp = ch.codePointAt(0)
      return !LOOKALIKE_CODEPOINTS.includes(cp) && !LOOKALIKE_RANGES.some(([a, b]) => cp >= a && cp <= b)
    })
    .join('')
}

export function cleanText(v, max = MAX_TEXT) {
  if (typeof v !== 'string') return ''
  return stripLookalikes(v)
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

function unknown(reason, extra = {}) {
  return { state: 'unknown', reason, ageSeconds: null, stale: false, generatedAt: null, market: 'unknown', headline: {}, checks: [], ...extra }
}

export function sanitizeCopilot(json, nowMs) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return unknown('schema mismatch: not an object')
  if (json.schema_version !== 1) return unknown('schema mismatch: unsupported schema_version')
  const generatedMs = parseUtcTimestamp(json.generated_at)
  if (generatedMs === null) return unknown('schema mismatch: bad generated_at')
  const ageSeconds = Math.round((nowMs - generatedMs) / 1000)
  if (ageSeconds < -FUTURE_TOLERANCE_S) return unknown('data timestamp is in the future (clock skew?)', { generatedAt: json.generated_at })
  if (!isStatus(json.overall)) return unknown('schema mismatch: bad overall')
  if (!Array.isArray(json.checks) || json.checks.length > MAX_CHECKS) return unknown('schema mismatch: bad checks')

  const checks = []
  for (const c of json.checks) {
    if (!c || typeof c !== 'object') return unknown('schema mismatch: bad check')
    if (typeof c.id !== 'string' || !ID_RE.test(c.id)) return unknown('schema mismatch: bad check id')
    if (!isStatus(c.status)) return unknown('schema mismatch: bad check status')
    checks.push({
      id: c.id,
      status: c.status,
      evidence: cleanText(c.evidence),
      threshold: cleanText(c.threshold),
      since: parseUtcTimestamp(c.since) !== null ? c.since : null,
    })
  }

  // A missing, zero or negative ttl cannot vouch for freshness; a huge one is capped.
  if (!Number.isFinite(json.ttl_s) || json.ttl_s <= 0) {
    return unknown('schema mismatch: no usable ttl_s', { ageSeconds, generatedAt: json.generated_at })
  }
  const ttl = Math.min(json.ttl_s, MAX_TTL_S)
  if (ageSeconds > ttl) {
    return unknown(`stale: data is ${ageSeconds}s old (limit ${ttl}s)`, { ageSeconds, stale: true, generatedAt: json.generated_at })
  }

  const headline = {}
  for (const k of HEADLINE_KEYS) {
    const v = json.headline?.[k]
    if (Number.isInteger(v) && v >= 0 && v <= 100000) headline[k] = v
  }
  const market = MARKETS.has(json.market?.state) ? json.market.state : 'unknown'
  const state = worstOf([json.overall, worstOf(checks.map((c) => c.status))])
  // Within the future tolerance the age is negative; report it as zero, not "-30s old".
  return { state, reason: null, ageSeconds: Math.max(0, ageSeconds), stale: false, generatedAt: json.generated_at, market, headline, checks }
}
