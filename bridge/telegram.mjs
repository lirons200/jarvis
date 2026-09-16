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
