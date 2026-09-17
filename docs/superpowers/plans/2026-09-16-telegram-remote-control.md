# Telegram Remote Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user monitor and control JARVIS's autonomous trading from Telegram — trade announcements, a `status` command, and a `halt` command — via a generic, extensible Telegram transport layer.

**Architecture:** `bridge/telegram.mjs` is a generic long-polling Telegram Bot API transport with a pluggable command router — it knows nothing about forex. `bridge/trading.mjs` gets two extracted, reusable functions (`getTradingStatusText`, `triggerHalt`) that both its existing MCP tools and the new Telegram commands call. `bridge/server.mjs` wires the two together by registering forex commands into the generic router, the same way it already registers MCP tools.

**Tech Stack:** Node.js (ESM), `net.mjs`'s existing SSRF-guarded HTTP client (no new npm dependency — raw calls to Telegram's Bot API), `node:test`.

**Depends on:** Phase 4 (`bridge/trading.mjs`'s `haltTrading`, `state`, `readJournalTail`, `fetchAccountPL`, `JOURNAL_PATH`).

**Spec:** `C:\Users\irons\jarvis\docs\superpowers\specs\2026-09-16-telegram-remote-control-design.md`

---

## File Structure

- **Modify:** `bridge/trading.mjs` — extract `getTradingStatusText()` and `triggerHalt(source)`, update the two existing MCP tools to call them instead of duplicating the logic.
- **Create:** `bridge/telegram.mjs` + test — generic transport: `parseCommand`, `isAuthorizedChat` (pure, tested), `registerCommand`, `sendMessage`/`getUpdates` (network, untested per this codebase's convention), `announceToTelegram`, `initTelegram`.
- **Modify:** `bridge/server.mjs` — wire in `initTelegram()`, register the forex `status`/`halt` commands, extend the existing trade-announcement callback to also reach Telegram.
- **Modify:** `README.md` — document the two new env vars and how to get a bot token/chat ID.

---

### Task 1: Extract `getTradingStatusText` and `triggerHalt` from `trading.mjs`

**Files:**
- Modify: `bridge/trading.mjs`

- [ ] **Step 1: Read the current file to confirm exact current content**

The two MCP tool handlers currently look like this (read the file yourself to confirm exact current line numbers before editing — they may have shifted):

```js
export function tradingServer() {
  return createSdkMcpServer({
    name: 'jarvis_trading',
    version: '1.0.0',
    instructions: 'Read-only status for the autonomous forex trading loop.',
    tools: [
      tool('trading_status', 'Report whether autonomous trading is armed, halted, and today\'s P&L.', {}, async () => {
        const tail = await readJournalTail(JOURNAL_PATH, 5)
        const lines = [
          state.armed ? (state.halted ? `Halted — ${state.haltReason}` : 'Armed and running') : 'Not armed',
        ]
        if (state.armed && state.config && state.dayKey !== null) {
          try {
            const { realizedPL, unrealizedPL } = await fetchAccountPL(state.config)
            const dailyRealizedPL = realizedPL - state.dayStartRealizedPL
            lines.push(`Today's P&L: ${(dailyRealizedPL + unrealizedPL).toFixed(2)} against a ${state.config.maxDailyLoss} loss cap`)
          } catch (err) {
            lines.push(`Could not fetch current P&L: ${err.message}`)
          }
        } else if (state.armed) {
          lines.push("Today's P&L: not yet established")
        }
        lines.push(`Recent activity: ${tail.length ? tail.map((e) => `${e.pair} ${e.event}`).join(', ') : 'none'}`)
        return { content: [{ type: 'text', text: lines.join('. ') }] }
      }),
    ],
  })
}

export function tradingControlServer() {
  return createSdkMcpServer({
    name: 'jarvis_trading_control',
    version: '1.0.0',
    instructions: 'The trading kill-switch. Always available, regardless of write permissions.',
    tools: [
      tool('trading_halt', 'Immediately stop autonomous trading. Existing stop-losses stay in place.', {}, async () => {
        haltTrading('halted by voice command')
        return { content: [{ type: 'text', text: 'Trading halted. Existing positions keep their stop-losses.' }] }
      }),
    ],
  })
}
```

- [ ] **Step 2: Extract the two reusable functions**

Add these two new exported functions immediately BEFORE `export function tradingServer()`:

```js
/**
 * Plain-text status report — armed/halted state, today's P&L against the
 * cap, recent journal activity. Extracted so both the trading_status MCP
 * tool and the Telegram `status` command call this exact same logic,
 * rather than each having their own copy that could drift apart.
 */
export async function getTradingStatusText() {
  const tail = await readJournalTail(JOURNAL_PATH, 5)
  const lines = [
    state.armed ? (state.halted ? `Halted — ${state.haltReason}` : 'Armed and running') : 'Not armed',
  ]
  if (state.armed && state.config && state.dayKey !== null) {
    try {
      const { realizedPL, unrealizedPL } = await fetchAccountPL(state.config)
      const dailyRealizedPL = realizedPL - state.dayStartRealizedPL
      lines.push(`Today's P&L: ${(dailyRealizedPL + unrealizedPL).toFixed(2)} against a ${state.config.maxDailyLoss} loss cap`)
    } catch (err) {
      lines.push(`Could not fetch current P&L: ${err.message}`)
    }
  } else if (state.armed) {
    lines.push("Today's P&L: not yet established")
  }
  lines.push(`Recent activity: ${tail.length ? tail.map((e) => `${e.pair} ${e.event}`).join(', ') : 'none'}`)
  return lines.join('. ')
}

/**
 * Halts trading, tagging the log line with who triggered it (`'voice'`,
 * `'telegram'`) — extracted for the same reason as getTradingStatusText,
 * and so a future caller (a scheduled safety check, say) has an obvious
 * place to hook in without duplicating haltTrading's own logic.
 */
export function triggerHalt(source) {
  haltTrading(`halted via ${source}`)
}
```

- [ ] **Step 3: Update the two MCP tool handlers to use them**

Replace the body of the `trading_status` tool's handler with:

```js
      tool('trading_status', 'Report whether autonomous trading is armed, halted, and today\'s P&L.', {}, async () => {
        const text = await getTradingStatusText()
        return { content: [{ type: 'text', text }] }
      }),
```

Replace the body of the `trading_halt` tool's handler with:

```js
      tool('trading_halt', 'Immediately stop autonomous trading. Existing stop-losses stay in place.', {}, async () => {
        triggerHalt('voice command')
        return { content: [{ type: 'text', text: 'Trading halted. Existing positions keep their stop-losses.' }] }
      }),
```

- [ ] **Step 4: Verify**

Run: `node --check bridge/trading.mjs`
Expected: no output.

Run: `node --test bridge/**/*.test.mjs`
Expected: all 79 existing tests still pass (this is a pure refactor — same behavior, no logic changed, so nothing should break).

- [ ] **Step 5: Commit**

```bash
git add bridge/trading.mjs
git commit -m "telegram: extract getTradingStatusText/triggerHalt for reuse outside the MCP tools"
```

---

### Task 2: Pure helpers — command parsing and chat authorization

**Files:**
- Create: `bridge/telegram.mjs`
- Test: `bridge/telegram.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `bridge/telegram.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCommand, isAuthorizedChat } from './telegram.mjs'

test('parseCommand recognises "status" with or without a leading slash', () => {
  assert.equal(parseCommand('status'), 'status')
  assert.equal(parseCommand('/status'), 'status')
  assert.equal(parseCommand('  Status  '), 'status')
})

test('parseCommand recognises "halt" with or without a leading slash', () => {
  assert.equal(parseCommand('halt'), 'halt')
  assert.equal(parseCommand('/halt'), 'halt')
  assert.equal(parseCommand('HALT'), 'halt')
})

test('parseCommand reports "unknown" for anything else', () => {
  assert.equal(parseCommand('hello'), 'unknown')
  assert.equal(parseCommand(''), 'unknown')
  assert.equal(parseCommand(undefined), 'unknown')
})

test('isAuthorizedChat matches the configured chat id exactly', () => {
  assert.equal(isAuthorizedChat(12345, '12345'), true)
  assert.equal(isAuthorizedChat('12345', '12345'), true)
  assert.equal(isAuthorizedChat(99999, '12345'), false)
})

test('isAuthorizedChat rejects a missing chat id', () => {
  assert.equal(isAuthorizedChat(undefined, '12345'), false)
  assert.equal(isAuthorizedChat(null, '12345'), false)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test bridge/telegram.test.mjs`
Expected: FAIL — `bridge/telegram.mjs` does not exist yet.

- [ ] **Step 3: Write the implementation**

Create `bridge/telegram.mjs`:

```js
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test bridge/telegram.test.mjs`
Expected: PASS, all 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add bridge/telegram.mjs bridge/telegram.test.mjs
git commit -m "telegram: add command parsing and chat authorization helpers"
```

---

### Task 3: Long-polling, sendMessage, command router, initTelegram

**Files:**
- Modify: `bridge/telegram.mjs`

- [ ] **Step 1: Write the implementation**

No new unit tests — real network calls, same convention as every other network-calling function in this codebase. Append to `bridge/telegram.mjs`:

```js
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
```

- [ ] **Step 2: Verify**

Run: `node --check bridge/telegram.mjs`
Expected: no output.

Run: `node --test bridge/telegram.test.mjs`
Expected: PASS — confirms the new imports (`openRemote`, `vetTarget`, `PROXY_UA`) don't throw at load time, and the 5 pure-function tests from Task 2 still pass.

- [ ] **Step 3: Commit**

```bash
git add bridge/telegram.mjs
git commit -m "telegram: add long-polling, sendMessage, the command router, and initTelegram"
```

---

### Task 4: Wire into server.mjs

**Files:**
- Modify: `bridge/server.mjs`

- [ ] **Step 1: Import the new module**

At the top of `bridge/server.mjs`, alongside the other bridge module imports:

```js
import { initTrading, tradingServer, tradingControlServer, getTradingStatusText, triggerHalt } from './trading.mjs'
import { initTelegram, registerCommand, announceToTelegram } from './telegram.mjs'
```

(`getTradingStatusText`/`triggerHalt` are new exports from Task 1 — add them to the existing `trading.mjs` import line rather than creating a duplicate import statement.)

- [ ] **Step 2: Start Telegram and register the forex commands**

Read the current `bridge/server.mjs` to find the existing block (from phase 4) that looks like:

```js
const TRADING_CONFIG = await initTrading((text) => {
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) {
      try {
        client.send(JSON.stringify({ type: 'announce', text }))
      } catch (err) {
        console.error(`[jarvis:trading] could not send announcement to a client: ${err.message}`)
      }
    }
  }
})
```

Immediately BEFORE this block, add:

```js
const TELEGRAM_CONFIG = initTelegram()
if (TELEGRAM_CONFIG) {
  registerCommand('status', async () => getTradingStatusText())
  registerCommand('halt', async () => {
    triggerHalt('telegram')
    return 'Trading halted. Existing positions keep their stop-losses.'
  })
}
```

Then modify the existing `initTrading((text) => { ... })` callback to ALSO reach Telegram — add one line inside the callback, alongside the existing WebSocket-push loop:

```js
const TRADING_CONFIG = await initTrading((text) => {
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) {
      try {
        client.send(JSON.stringify({ type: 'announce', text }))
      } catch (err) {
        console.error(`[jarvis:trading] could not send announcement to a client: ${err.message}`)
      }
    }
  }
  void announceToTelegram(text)
})
```

- [ ] **Step 3: Log Telegram status in the boot banner**

Near the other boot `console.log` lines (e.g. right after the trading status line):

```js
console.log(
  TELEGRAM_CONFIG
    ? '[jarvis] telegram remote control active'
    : '[jarvis] telegram remote control disabled — set JARVIS_TELEGRAM_BOT_TOKEN and JARVIS_TELEGRAM_CHAT_ID to enable',
)
```

- [ ] **Step 4: Verify**

Run: `node --check bridge/server.mjs`
Expected: no output.

Run: `node --test bridge/**/*.test.mjs`
Expected: all tests across every phase pass.

Run the bridge with no Telegram env vars set: `node bridge/server.mjs` (stop it after confirming the boot log)
Expected log includes `[jarvis:telegram] disabled — set JARVIS_TELEGRAM_BOT_TOKEN and JARVIS_TELEGRAM_CHAT_ID to enable` and `[jarvis] telegram remote control disabled — ...`, and the bridge otherwise starts normally.

- [ ] **Step 5: Commit**

```bash
git add bridge/server.mjs
git commit -m "telegram: wire the bot into the bridge, register forex status/halt commands"
```

---

### Task 5: Env var documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document the new env vars**

In `README.md`'s `### Bridge` config table, add:

```markdown
| `JARVIS_TELEGRAM_BOT_TOKEN` | unset | Telegram bot token from @BotFather. Unset disables the Telegram bot entirely. |
| `JARVIS_TELEGRAM_CHAT_ID` | unset | The one chat id the bot will respond to — messages from any other chat are silently ignored. |
```

- [ ] **Step 2: Add a short setup section**

Add a `### Telegram remote control` section after the `### ⚠️ Autonomous trading` section:

````markdown
### Telegram remote control

Monitor and control autonomous trading from Telegram — get trade
announcements as messages, and message the bot `status` or `halt`
from anywhere.

1. Message [@BotFather](https://t.me/BotFather) on Telegram, send `/newbot`,
   follow the prompts — you'll get a bot token.
2. Message your new bot anything, then visit
   `https://api.telegram.org/bot<your-token>/getUpdates` in a browser to find
   your numeric chat id in the response.
3. Set both env vars:

```bash
JARVIS_TELEGRAM_BOT_TOKEN=<token from BotFather>
JARVIS_TELEGRAM_CHAT_ID=<your numeric chat id>
```

Message the bot `status` or `halt` at any time. Anyone else who messages the
bot is silently ignored — it only ever responds to the one configured chat.
````

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "telegram: document setup and the new env vars"
```

---

### Task 6: Manual verification

**Files:** none (verification only)

- [ ] **Step 1: Start the bridge with a real Telegram bot token and chat id**

```bash
JARVIS_TELEGRAM_BOT_TOKEN=<token> JARVIS_TELEGRAM_CHAT_ID=<chat id> npm run bridge
```

Confirm the boot log shows `[jarvis:telegram] bot active` and `[jarvis] telegram remote control active`.

- [ ] **Step 2: Verify the `status` command**

Message the bot `status`. Confirm a reply arrives matching what `trading_status` reports via voice (e.g. "Not armed" if trading env vars aren't also set).

- [ ] **Step 3: Verify unauthorized chats are ignored**

From a different Telegram account/chat, message the bot anything. Confirm no reply arrives at all (check the bridge logs show nothing suspicious either — the message should simply be skipped, not logged as an error).

- [ ] **Step 4: Verify the `halt` command**

With trading also enabled and armed (per phase 4's verification steps), message the bot `halt`. Confirm a reply arrives, and that the bridge log shows `HALTED — halted via telegram`, and that `trading_status` (via voice or a `status` message) subsequently reports "Halted".

- [ ] **Step 5: Verify trade announcements reach Telegram**

If a trade fires during testing (or by following phase 4's manual trade-cycle verification), confirm the announcement arrives as a Telegram message, not just spoken/on the WebSocket.

---

## Self-Review Notes

- **Spec coverage:** generic transport / forex-specific commands split → Task 3 (transport, forex-agnostic) + Task 4 (registers forex commands from outside). `getTradingStatusText`/`triggerHalt` reuse, not duplication → Task 1. Chat-ID authorization, silent ignore of unauthorized chats → Task 2 (`isAuthorizedChat`) + Task 3 (`pollOnce`'s `continue` on an unauthorized chat, no reply sent). Announcements reaching Telegram as a second channel alongside the WebSocket push → Task 4 Step 2. Error handling (Telegram outage doesn't affect trading, `sendMessage` failure doesn't throw into `announce()`) → Task 3's `announceToTelegram` try/catch. Optional-subsystem pattern (both env vars required together, rest of bridge unaffected) → Task 3's `initTelegram`.
- **No placeholders:** every step has complete, runnable code.
- **Type/name consistency check:** `parseCommand`, `isAuthorizedChat`, `registerCommand`, `announceToTelegram`, `initTelegram`, `getTradingStatusText`, `triggerHalt` are used identically everywhere they're referenced across `telegram.mjs`, `trading.mjs`, and `server.mjs`.
