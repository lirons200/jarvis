/**
 * Generic Telegram Bot API transport — long-polling, sending messages,
 * and a pluggable command router. This file knows nothing about forex or
 * trading; the forex-specific commands (status/halt) are registered into
 * it from bridge/server.mjs, the same way MCP tools are wired up there.
 * Free text (anything that is not a command) goes to a single injected
 * message handler, registered with registerMessageHandler(); this file only
 * supplies the guard rails around it (timeout, one-at-a-time, rate limit,
 * chunking, error scrubbing) and never imports an agent SDK.
 */

import { openRemote, vetTarget, PROXY_UA } from './net.mjs'

/**
 * "status", "/status", "  Status  " all recognised — Telegram clients
 * commonly send commands with a leading slash, but plain text is friendlier
 * for a personal bot, so both are accepted.
 */
export function parseCommand(text) {
  const trimmed = String(text ?? '').trim().toLowerCase().replace(/^\//, '')
  if (trimmed === 'status') return 'status'
  if (trimmed === 'halt') return 'halt'
  return 'unknown'
}

/** String-compares so a numeric chat id from Telegram and a string env var match. */
export function isAuthorizedChat(chatId, allowedChatId) {
  if (chatId === undefined || chatId === null) return false
  return String(chatId) === String(allowedChatId)
}

/** True for "/anything" — kept out of the free-text path so a mistyped or
 *  unregistered command gets the command fallback, not a conversation. */
export function isSlashCommand(text) {
  return String(text ?? '').trim().startsWith('/')
}

/** Telegram rejects a sendMessage whose text is longer than this. */
export const TELEGRAM_MAX_CHARS = 4096

/**
 * Splits text into pieces of at most `limit` characters, preferring to break
 * at a paragraph, then a line, then a space, and only hard-cutting a run with
 * no break in it. Never returns an empty piece; returns [] for empty text.
 */
export function chunkMessage(text, limit = TELEGRAM_MAX_CHARS) {
  const chunks = []
  let rest = String(text ?? '').trim()
  while (rest.length > limit) {
    let cut = limit
    for (const sep of ['\n\n', '\n', ' ']) {
      const i = rest.lastIndexOf(sep, limit)
      // Ignore a break so early it would produce a tiny sliver.
      if (i > limit / 2) {
        cut = i
        break
      }
    }
    let piece = rest.slice(0, cut)
    // Do not cut between the halves of a surrogate pair.
    if (/[\ud800-\udbff]$/.test(piece)) piece = piece.slice(0, -1)
    chunks.push(piece.trimEnd())
    rest = rest.slice(piece.length).trimStart()
  }
  if (rest) chunks.push(rest)
  return chunks.filter((c) => c.length > 0)
}

/**
 * Sliding-window limiter: at most `max` acquisitions per `windowMs`.
 * `now` is a parameter so tests need no fake timers.
 */
export function createRateLimiter({ max, windowMs }) {
  let stamps = []
  return {
    tryAcquire(now = Date.now()) {
      stamps = stamps.filter((t) => now - t < windowMs)
      if (stamps.length >= max) return false
      stamps.push(now)
      return true
    },
  }
}

/** Longest free-text message accepted; longer is refused, not truncated. */
export const MAX_INPUT_CHARS = 2000
const TIMEOUT_GRACE_MS = 5_000

/**
 * Wraps a message handler with the guard rails. Returns async `dispatch(text)`
 * resolving to the reply string — always a string, never throws, and never
 * carries an error message from the handler (those can contain paths or
 * secrets; only the error's class name goes to the console).
 *
 * At most one handler call is in flight: a second message while one runs is
 * refused with a short reply rather than queued, so a burst can't stack up
 * agent runs. The handler receives an AbortSignal that fires on timeout.
 */
export function createChatDispatcher({ handler, limiter, timeoutMs, maxInput = MAX_INPUT_CHARS, graceMs = TIMEOUT_GRACE_MS }) {
  let busy = false
  let current = null
  return async function dispatch(text) {
    const input = String(text ?? '').trim()
    if (!input) return 'Send me some text.'
    if (input.length > maxInput) return `That message is too long (limit ${maxInput} characters).`
    if (busy) return 'Still working on your last message — try again in a moment.'
    if (!limiter.tryAcquire()) return 'Slow down a little — too many messages. Try again shortly.'

    busy = true
    const controller = new AbortController()
    let timer
    let grace
    // A per-call token: a hung handler's late release must not clear the busy
    // flag of a newer run that took the slot after the grace release.
    const token = (current = {})
    const release = () => {
      clearTimeout(grace)
      if (current === token) busy = false
    }
    const work = Promise.resolve().then(() => handler(input, controller.signal))
    // Released when the handler truly settles; the grace fallback below covers
    // one that ignores the abort signal so the bot can't wedge forever.
    work.then(release, release)
    try {
      const reply = await Promise.race([
        work,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort()
            grace = setTimeout(release, graceMs)
            reject(new Error('timeout'))
          }, timeoutMs)
        }),
      ])
      return String(reply ?? '').trim() || 'I have nothing to say to that.'
    } catch (err) {
      if (err?.message === 'timeout') return 'That took too long, so I stopped. Try a simpler question.'
      console.error(`[jarvis:telegram] message handler failed: ${err?.name ?? 'Error'}`)
      return 'Something went wrong handling that. Try again.'
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * Full message authorization: a private chat, whose chat id AND sender id both
 * equal the configured id. Checking chat.id alone would let any member of a
 * group that happens to carry the id (or a forwarded/channel post) through.
 */
export function isAuthorizedMessage(msg, allowedChatId) {
  return (
    msg?.chat?.type === 'private' &&
    isAuthorizedChat(msg.chat.id, allowedChatId) &&
    isAuthorizedChat(msg.from?.id, allowedChatId)
  )
}

const FETCH_TIMEOUT_MS = 30_000
const MAX_RESPONSE_BYTES = 1024 * 1024
/** Telegram's own long-poll wait, in seconds — the HTTP timeout above must
 *  exceed this or every poll would time out on the client side. */
const POLL_WAIT_S = 25

async function readJsonBody(res, maxBytes) {
  const chunks = []
  let size = 0
  for await (const chunk of res) {
    size += chunk.length
    if (size > maxBytes) {
      res.destroy()
      throw new Error('telegram response too large')
    }
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch (err) {
    // A non-JSON body (an HTML error page from a proxy, say) must not leak
    // the socket — net.mjs's own fetchText is careful about exactly this.
    res.destroy()
    throw err
  }
}

/** Bounds how many updates one poll can return — without this, a very
 *  large backlog (e.g. after a long outage) would be re-fetched in full on
 *  every tick if it ever exceeded MAX_RESPONSE_BYTES, since a failed parse
 *  doesn't advance updateOffset. */
const UPDATES_PER_POLL = 20

async function getUpdates(token, offset) {
  const url = vetTarget(
    `https://api.telegram.org/bot${token}/getUpdates?timeout=${POLL_WAIT_S}&offset=${offset}&limit=${UPDATES_PER_POLL}`,
  )
  const { res } = await openRemote(
    url,
    { 'user-agent': PROXY_UA, accept: 'application/json' },
    (POLL_WAIT_S + 5) * 1000,
  )
  return readJsonBody(res, MAX_RESPONSE_BYTES)
}

async function sendMessage(token, chatId, text) {
  const url = vetTarget(`https://api.telegram.org/bot${token}/sendMessage`)
  const { res } = await openRemote(
    url,
    { 'user-agent': PROXY_UA, accept: 'application/json', 'content-type': 'application/json' },
    FETCH_TIMEOUT_MS,
    { method: 'POST', body: JSON.stringify({ chat_id: chatId, text }) },
  )
  return readJsonBody(res, MAX_RESPONSE_BYTES)
}

/**
 * Command name -> async handler returning the reply text. Registered from
 * outside this file (bridge/server.mjs) — see the module doc comment.
 */
const commands = new Map()

export function registerCommand(name, handler) {
  commands.set(name, handler)
}

/** The one free-text handler, set from outside; see createChatDispatcher. */
let dispatchChat = null

/**
 * Registers the handler for non-command text from the authorized chat.
 * `handler(text, signal)` resolves to reply text. Defaults are deliberately
 * tight: the handler is an agent behind a remote input channel.
 */
export function registerMessageHandler(handler, { timeoutMs = 90_000, maxPerMinute = 6 } = {}) {
  dispatchChat = createChatDispatcher({
    handler,
    limiter: createRateLimiter({ max: maxPerMinute, windowMs: 60_000 }),
    timeoutMs,
  })
}

async function replyChunks(token, chatId, text) {
  for (const piece of chunkMessage(text)) await sendMessage(token, chatId, piece)
}

/** Set once initTelegram() succeeds; a no-op before that or if never configured. */
let sendToConfiguredChat = null

/**
 * Sends a trade announcement (or any other proactive text) to the
 * configured chat. Safe to call even when Telegram isn't configured —
 * becomes a no-op, matching how the WebSocket announce push already
 * tolerates no browser being connected.
 */
export async function announceToTelegram(text) {
  if (!sendToConfiguredChat) return
  try {
    await sendToConfiguredChat(text)
  } catch (err) {
    console.error(`[jarvis:telegram] could not send announcement: ${err.message}`)
  }
}

let pollTimer = null
let updateOffset = 0

/** Normal gap between polls when healthy. */
export const POLL_INTERVAL_MS = 1000
export const CONFLICT_BACKOFF_BASE_MS = 30_000
export const ERROR_BACKOFF_BASE_MS = 5_000
export const BACKOFF_CAP_MS = 5 * 60_000
export const BACKOFF_LOG_EVERY_MS = 10 * 60_000

/**
 * True for Telegram's "another getUpdates consumer holds this token" answer.
 * net.mjs's openRemote does not throw on non-200, so it normally arrives as a
 * parsed body ({ ok:false, error_code:409 }); a thrown error carrying
 * status 409 is accepted too in case a lower layer starts rejecting.
 */
export function isPollConflict(dataOrErr) {
  if (!dataOrErr || typeof dataOrErr !== 'object') return false
  return dataOrErr.error_code === 409 || dataOrErr.status === 409 || dataOrErr.statusCode === 409
}

/** Doubles from `base` (0 = no backoff yet), never exceeding the cap. */
export function nextBackoffMs(prevMs, base, cap = BACKOFF_CAP_MS) {
  if (!prevMs || prevMs <= 0) return Math.min(base, cap)
  return Math.min(prevMs * 2, cap)
}

export function initialPollState() {
  return { mode: 'ok', backoffMs: 0, lastLogAt: 0, failures: 0 }
}

/**
 * Pure reducer for one poll outcome. `outcome` is { kind: 'ok' | 'conflict' |
 * 'error', message? }. Returns the next state, the delay before the next poll,
 * and `log` (null, or { level, kind, message }) so the caller only prints on
 * entering a failure state, every BACKOFF_LOG_EVERY_MS after that, and on
 * recovery, rather than on every retry.
 */
export function advancePollState(state, outcome, now) {
  if (outcome.kind === 'ok') {
    const recovered = state.mode !== 'ok'
    return {
      state: initialPollState(),
      delayMs: POLL_INTERVAL_MS,
      log: recovered
        ? { level: 'info', kind: 'recovered', message: `Telegram polling recovered after ${state.failures} failed poll(s)` }
        : null,
    }
  }
  const mode = outcome.kind
  const sameMode = state.mode === mode
  const base = mode === 'conflict' ? CONFLICT_BACKOFF_BASE_MS : ERROR_BACKOFF_BASE_MS
  const backoffMs = nextBackoffMs(sameMode ? state.backoffMs : 0, base)
  const shouldLog = !sameMode || now - state.lastLogAt >= BACKOFF_LOG_EVERY_MS
  const message = mode === 'conflict'
    ? 'Telegram 409 Conflict: another process is polling getUpdates with the same bot token. '
      + 'Only one poller can receive updates, so commands may be missed by JARVIS or the other bot. '
      + 'Fix: give JARVIS its own bot token (JARVIS_TELEGRAM_BOT_TOKEN) or stop the other poller. '
      + 'Backing off and retrying quietly.'
    : `${outcome.message ?? 'poll failed'} — backing off ${Math.round(backoffMs / 1000)}s`
  return {
    state: { mode, backoffMs, lastLogAt: shouldLog ? now : state.lastLogAt, failures: (sameMode ? state.failures : 0) + 1 },
    delayMs: backoffMs,
    log: shouldLog ? { level: mode === 'conflict' ? 'warn' : 'error', kind: mode, message } : null,
  }
}

let pollState = initialPollState()

function applyPollOutcome(outcome) {
  const step = advancePollState(pollState, outcome, Date.now())
  pollState = step.state
  if (step.log) {
    const write = step.log.level === 'info' ? console.log : step.log.level === 'warn' ? console.warn : console.error
    write(`[jarvis:telegram] ${step.log.message}`)
  }
  return step.delayMs
}

/** Returns the delay (ms) before the next poll. */
async function pollOnce(token, chatId) {
  let data
  try {
    data = await getUpdates(token, updateOffset)
  } catch (err) {
    return applyPollOutcome(
      isPollConflict(err) ? { kind: 'conflict' } : { kind: 'error', message: `poll failed: ${err.message}` },
    )
  }
  if (data?.ok !== true) {
    return applyPollOutcome(
      isPollConflict(data)
        ? { kind: 'conflict' }
        : { kind: 'error', message: `Telegram API error: ${data?.description ?? 'unknown error'} — check JARVIS_TELEGRAM_BOT_TOKEN` },
    )
  }
  const nextDelay = applyPollOutcome({ kind: 'ok' })
  for (const update of data.result ?? []) {
    updateOffset = update.update_id + 1
    const msg = update.message
    if (!msg?.text) continue
    if (!isAuthorizedMessage(msg, chatId)) continue

    const name = parseCommand(msg.text)
    if (name === 'unknown' && !isSlashCommand(msg.text) && dispatchChat) {
      // Deliberately not awaited: a slow agent answer must not block the poll
      // loop, or /halt sent while it runs would sit unread until it finished.
      // Concurrency is bounded inside the dispatcher instead.
      void dispatchChat(msg.text)
        .then((reply) => replyChunks(token, chatId, reply))
        .catch((err) => console.error(`[jarvis:telegram] chat reply failed: ${err.message}`))
      continue
    }
    const handler = commands.get(name)
    try {
      const reply = handler
        ? await handler()
        : `I understand: ${[...commands.keys()].join(', ')}.`
      await sendMessage(token, chatId, reply)
    } catch (err) {
      console.error(`[jarvis:telegram] command handling failed: ${err.message}`)
    }
  }
  return nextDelay
}

function startPolling(token, chatId) {
  const tick = async () => {
    let delay = POLL_INTERVAL_MS
    try {
      delay = await pollOnce(token, chatId)
    } catch (err) {
      // pollOnce handles its own failures; this only keeps the loop alive.
      console.error(`[jarvis:telegram] poll loop error: ${err.message}`)
      delay = BACKOFF_CAP_MS
    }
    pollTimer = setTimeout(tick, delay)
  }
  void tick()
  return () => {
    if (pollTimer) clearTimeout(pollTimer)
  }
}

/**
 * Boot-time setup. Both env vars are required together; the rest of the
 * bridge is unaffected either way, matching every other optional
 * subsystem (forex, backtest, trading) in this codebase.
 */
export function isValidChatId(value) {
  return typeof value === 'string' && /^\d+$/.test(value.trim())
}

export function initTelegram() {
  const token = process.env.JARVIS_TELEGRAM_BOT_TOKEN
  const chatId = process.env.JARVIS_TELEGRAM_CHAT_ID?.trim()
  if (!token || !chatId) {
    console.log(
      '[jarvis:telegram] disabled — set JARVIS_TELEGRAM_BOT_TOKEN and ' +
        'JARVIS_TELEGRAM_CHAT_ID to enable',
    )
    return null
  }
  if (!isValidChatId(chatId)) {
    console.error('[jarvis:telegram] disabled — JARVIS_TELEGRAM_CHAT_ID must be your numeric private chat id')
    return null
  }
  sendToConfiguredChat = (text) => sendMessage(token, chatId, text)
  startPolling(token, chatId)
  console.log('[jarvis:telegram] bot active')
  // Deliberately omits the token — every caller only ever checks this for
  // truthiness (server.mjs's `if (TELEGRAM_CONFIG)`), so there's no reason
  // for the secret to live in a module-level binding a future stray
  // console.log could expose.
  return { chatId }
}
