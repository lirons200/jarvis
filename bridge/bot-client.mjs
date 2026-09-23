/**
 * Read-only client for the Python bot's dashboard. GET only, exact path
 * allowlist, no redirects, size- and time-capped. It deliberately does NOT use
 * the general web proxy client in net.mjs: that one blocks loopback (which is
 * where an SSH tunnel lands) and follows redirects. Only the single configured
 * origin can ever be contacted. Plain http is accepted only to loopback;
 * anything remote must be https.
 */
import http from 'node:http'
import https from 'node:https'

// v1 needs exactly one endpoint. Drill-down paths (/api/status, /api/strategies,
// /api/mission, /api/mission/activity) are added only when a tool actually uses
// them, so no unused surface exists. The bot's two state-changing endpoints
// (/api/mission/epoch, /api/refresh-trades) must never be added.
export const ALLOWED_PATHS = new Set(['/api/copilot'])
const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost'])
export const MAX_BYTES = 512 * 1024
export const TIMEOUT_MS = 8000

export function parseBaseUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, kind: 'not_configured', detail: 'JARVIS_BOT_DASHBOARD_URL is not set' }
  }
  let url
  try {
    url = new URL(raw.trim())
  } catch {
    return { ok: false, kind: 'bad_config', detail: 'invalid URL' }
  }
  if (url.username || url.password) return { ok: false, kind: 'bad_config', detail: 'credentials in the URL are not allowed' }
  if (url.pathname !== '/' || url.search || url.hash) return { ok: false, kind: 'bad_config', detail: 'the URL must be an origin only' }
  if (url.protocol === 'http:') {
    if (!LOOPBACK.has(url.hostname)) {
      return { ok: false, kind: 'bad_config', detail: 'plain http is only allowed to loopback; use an SSH tunnel or https' }
    }
  } else if (url.protocol !== 'https:') {
    return { ok: false, kind: 'bad_config', detail: 'unsupported protocol' }
  }
  return { ok: true, origin: url.origin }
}

export function isAllowedPath(path) {
  return typeof path === 'string' && ALLOWED_PATHS.has(path)
}

export function realRequest(urlString, { timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString)
    const mod = url.protocol === 'https:' ? https : http
    const req = mod.request(
      url,
      { method: 'GET', headers: { accept: 'application/json', 'user-agent': 'jarvis-bot-client' }, agent: false, timeout: timeoutMs },
      (res) => {
        const chunks = []
        let size = 0
        res.on('data', (c) => {
          size += c.length
          if (size > MAX_BYTES) {
            res.destroy()
            resolve({ tooLarge: true })
            return
          }
          chunks.push(c)
        })
        res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
        res.on('error', reject)
      },
    )
    // `timeout` above is only an idle timeout; a server that drips one byte at a
    // time would hold the request open for minutes. This is the total deadline.
    const deadline = setTimeout(() => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), timeoutMs)
    req.on('close', () => clearTimeout(deadline))
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })))
    req.on('error', reject)
    req.end()
  })
}

/** @returns {Promise<{ok:true,json:any}|{ok:false,kind:string,detail:string}>} */
export async function botGet(base, path, { request = realRequest } = {}) {
  if (!base?.ok) return { ok: false, kind: base?.kind ?? 'not_configured', detail: base?.detail ?? 'not configured' }
  if (!isAllowedPath(path)) return { ok: false, kind: 'bad_path', detail: 'path not allowed' }
  let res
  try {
    res = await request(base.origin + path, { method: 'GET' })
  } catch (err) {
    return { ok: false, kind: 'unreachable', detail: typeof err?.code === 'string' ? err.code : 'network error' }
  }
  if (res?.tooLarge) return { ok: false, kind: 'too_large', detail: 'response too large' }
  const status = res?.statusCode ?? 0
  if (status === 403) return { ok: false, kind: 'forbidden', detail: 'HTTP 403' }
  if (status >= 300 && status < 400) return { ok: false, kind: 'http_error', detail: 'redirect not followed' }
  if (status < 200 || status >= 300) return { ok: false, kind: 'http_error', detail: `HTTP ${status}` }
  if (!String(res.headers?.['content-type'] ?? '').includes('application/json')) {
    return { ok: false, kind: 'not_json', detail: 'unexpected content type' }
  }
  try {
    return { ok: true, json: JSON.parse(res.body) }
  } catch {
    return { ok: false, kind: 'not_json', detail: 'invalid JSON' }
  }
}
