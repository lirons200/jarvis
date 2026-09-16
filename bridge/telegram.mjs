/**
 * Generic Telegram Bot API transport — long-polling, sending messages,
 * and a pluggable command router. This file knows nothing about forex or
 * trading; the forex-specific commands (status/halt) are registered into
 * it from bridge/server.mjs, the same way MCP tools are wired up there.
 * A future phase that routes free text into the Claude Agent SDK
 * conversation would register another handler here, not rewrite this
 * transport.
 */

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

import { openRemote, vetTarget, PROXY_UA } from './net.mjs'

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
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

async function getUpdates(token, offset) {
  const url = vetTarget(
    `https://api.telegram.org/bot${token}/getUpdates?timeout=${POLL_WAIT_S}&offset=${offset}`,
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

async function pollOnce(token, chatId) {
  let data
  try {
    data = await getUpdates(token, updateOffset)
  } catch (err) {
    console.error(`[jarvis:telegram] poll failed: ${err.message}`)
    return
  }
  for (const update of data?.result ?? []) {
    updateOffset = update.update_id + 1
    const msg = update.message
    if (!msg?.text) continue
    if (!isAuthorizedChat(msg.chat?.id, chatId)) continue

    const name = parseCommand(msg.text)
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
}

function startPolling(token, chatId) {
  const tick = async () => {
    await pollOnce(token, chatId)
    pollTimer = setTimeout(tick, 1000)
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
export function initTelegram() {
  const token = process.env.JARVIS_TELEGRAM_BOT_TOKEN
  const chatId = process.env.JARVIS_TELEGRAM_CHAT_ID
  if (!token || !chatId) {
    console.log(
      '[jarvis:telegram] disabled — set JARVIS_TELEGRAM_BOT_TOKEN and ' +
        'JARVIS_TELEGRAM_CHAT_ID to enable',
    )
    return null
  }
  sendToConfiguredChat = (text) => sendMessage(token, chatId, text)
  startPolling(token, chatId)
  console.log('[jarvis:telegram] bot active')
  return { token, chatId }
}
