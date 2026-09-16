# Telegram Remote Control — Design Spec

Status: Approved (pre-implementation)
Date: 2026-09-16
Scope: Phase 5 of the forex project — the first phase not scoped to forex data/execution itself, but to a new remote-control surface. Depends on phase 4 (`bridge/trading.mjs`'s state/halt/status logic) for its first (and for now, only) command set.

## Goal

Let the user monitor and control JARVIS's autonomous trading from Telegram — trade announcements pushed as messages, a `status` command, and a `halt` command — without needing to be at the machine or have the browser open.

## Design principle: generic transport, forex-specific commands (for now)

The user has asked that this be built as a step toward a fully integrated JARVIS assistant reachable over Telegram in a future phase, not a one-off forex notifier. So the module is split into two layers from the start:

- **`bridge/telegram.mjs`** — the generic transport: long-polling Telegram's Bot API, sending messages, chat-ID authorization, and a pluggable command router. It knows nothing about forex, trading, or JARVIS's conversation loop. This is the piece a future phase (e.g. routing free text into the Claude Agent SDK the way voice does) would extend, by registering a new handler — not by rewriting this file.
- **Forex-specific command handlers** — registered into that router from `bridge/trading.mjs` (reusing this phase's own `getTradingStatusText()`/`triggerHalt()` refactor) and wired up in `bridge/server.mjs`, the same way `jarvis_trading`/`jarvis_trading_control` are wired up as MCP tools today. Nothing forex-specific lives inside `telegram.mjs` itself.

This keeps today's scope (forex remote control) small and shippable while not painting the transport into a corner — the explicit extension point for "general JARVIS conversation via Telegram" is a future handler registered with the same router, not a redesign.

## Refactor: `trading.mjs` gets two reusable functions

Currently `trading_status` and `trading_halt`'s logic lives inline inside their MCP tool handlers in `bridge/trading.mjs`. This phase extracts:

- `getTradingStatusText(): Promise<string>` — exactly what the `trading_status` MCP tool returns today, pulled out so a second caller (Telegram) doesn't duplicate the logic.
- `triggerHalt(source: string): void` — wraps the existing `haltTrading()`, taking a `source` string (`'voice'`, `'telegram'`) so the halt log line and any future audit trail can say who triggered it, not just that it happened.

Both the MCP tool handlers and the new Telegram command handlers call these same two functions — there is exactly one implementation of "what status means" and "what halting means."

## `bridge/telegram.mjs` — generic transport

- **Long-polling** Telegram's `getUpdates` endpoint on an interval, using `net.mjs`'s SSRF-guarded client (matching every other outbound call in this bridge) — no new npm dependency.
- **`sendMessage(text)`** — posts to Telegram's `sendMessage` endpoint for the configured chat.
- **Authorization**: every incoming update's chat ID is checked against `JARVIS_TELEGRAM_CHAT_ID`. A message from any other chat is silently ignored — no reply, no acknowledgment, nothing that confirms the bot exists to a stranger who finds it.
- **Command router**: a small registry (`registerCommand(name, handler)`) that `initTelegram()` exposes. Trading's handlers register themselves into it (see below). An unrecognized command gets a short "I understand `status` and `halt`" reply — this default message is itself expected to grow/change once more commands exist in a future phase, so it's written as a fallback the router owns, not hardcoded assuming only these two commands will ever exist.
- **Startup**: `JARVIS_TELEGRAM_BOT_TOKEN` and `JARVIS_TELEGRAM_CHAT_ID` are both required together — the bot doesn't start without both, and the rest of the bridge is unaffected either way (same "optional subsystem" pattern as forex/backtest/trading).

## Forex command wiring (this phase's actual commands)

In `bridge/server.mjs`, after `initTelegram()` succeeds:
- `registerCommand('status', async () => getTradingStatusText())`
- `registerCommand('halt', async () => { triggerHalt('telegram'); return 'Trading halted.' })`

## Announcements

The existing `onAnnounce` callback in `trading.mjs` (already wired to push WebSocket messages to the browser) gets a second subscriber: if Telegram is configured, every trade announcement is also sent as a Telegram message via `sendMessage()`. This means the announcement reaches you whether or not the browser is open — matching the phase 4 design's point that the journal, not the WebSocket push, is the real system of record, and Telegram becomes a second best-effort notification channel alongside the voice one.

## Error handling

- Telegram API errors (network failure, invalid token) during polling are logged and the poll loop continues retrying on the next interval — same backoff-free "log and try again" pattern as other pollers in this codebase, since Telegram API outages are rare and short.
- A `sendMessage` failure (e.g. during an announcement) is logged but never throws back into the trading poller's `announce()` call — a failed Telegram send must not affect trading logic in any way.
- Missing/invalid env vars: `initTelegram()` returns `null`, logs why, and the bridge continues normally without the Telegram bot — exactly like every other optional subsystem in this codebase.

## Testing

- `parseCommand(text): 'status' | 'halt' | 'unknown'` — a pure function, unit-tested with `node --test`.
- The chat-ID authorization check (`isAuthorizedChat(chatId, allowedChatId)`) — pure, tested.
- The long-polling loop and `sendMessage` itself are not unit-tested — real network calls, same convention as every other network-calling function in this codebase (`fetchPricingOnce`, `fetchCandlesOnce`, the trading order calls) — verified manually against a real Telegram bot.
