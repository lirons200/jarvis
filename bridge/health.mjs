/**
 * Payload for GET /health. Booleans and counters only: no tokens, account ids,
 * pairs, positions or paths. Anything added here is readable by whatever can
 * reach the port, so keep it that way.
 */
export function buildHealth({ uptimeSeconds, version, tts, stt, forexFeed, trading, telegram }) {
  return {
    ok: true,
    uptime: Math.max(0, Math.floor(Number(uptimeSeconds) || 0)),
    version: typeof version === 'string' ? version : 'unknown',
    // Kept for the browser, which reads these at boot to pick a voice engine.
    tts: Boolean(tts),
    stt: Boolean(stt),
    forexFeed: Boolean(forexFeed),
    trading: {
      enabled: Boolean(trading?.enabled),
      armed: Boolean(trading?.armed),
      halted: Boolean(trading?.halted),
    },
    telegram: Boolean(telegram),
  }
}
