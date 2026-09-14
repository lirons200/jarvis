/**
 * The trading poller, trade journal, boot reconciliation, and the two
 * trading MCP servers. Everything here orchestrates the pure functions in
 * trading-signal.mjs/trading-risk.mjs and the network calls in
 * trading-orders.mjs — this file owns state (the journal, the halt flag)
 * and timing, not strategy or risk math.
 */

import { mkdir, appendFile, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * The durable system of record. A proactive spoken announcement is a
 * convenience layered on top of this — if the browser tab is closed when a
 * trade fires, the journal still has it, which the WebSocket push alone
 * would not guarantee.
 */
export async function appendJournalEntry(path, entry) {
  await mkdir(dirname(path), { recursive: true })
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry })
  await appendFile(path, line + '\n', 'utf8')
}

/** Most recent `n` journal entries, oldest first (i.e. most recent last). */
export async function readJournalTail(path, n) {
  let content
  try {
    content = await readFile(path, 'utf8')
  } catch {
    return []
  }
  const lines = content.trim().split('\n').filter(Boolean)
  return lines.slice(-n).map((line) => JSON.parse(line))
}
