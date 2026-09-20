/**
 * The options for the forced-read-only agent session that answers Telegram
 * messages. Lives here (not in server.mjs, which starts a server on import) so
 * the exact production options can also be exercised against the real SDK by
 * scripts/verify-telegram-session.mjs.
 */
import { forexServer } from './forex.mjs'
import { backtestServer } from './backtest.mjs'
import { tradingServer } from './trading.mjs'
import { isReadOnlySessionTool, READ_ONLY_BUILTINS, WRITE_BUILTINS } from './tool-gate.mjs'

/**
 * Final authority: the exact-allowlist gate. `onDecision(toolName, allowed)` is
 * an optional observer (server logs, the verify script records).
 */
export function telegramCanUseTool(onDecision) {
  return async (toolName) => {
    const ok = isReadOnlySessionTool(toolName)
    onDecision?.(toolName, ok)
    return ok
      ? { behavior: 'allow' }
      : { behavior: 'deny', message: 'Not available over Telegram.' }
  }
}

export function telegramSessionOptions({ abortController, systemPrompt, model, effort, cwd, onDecision }) {
  return {
    abortController,
    mcpServers: {
      jarvis_forex: forexServer(),
      jarvis_backtest: backtestServer(),
      jarvis_trading: tradingServer(),
    },
    strictMcpConfig: true,
    tools: [],
    // Empty on purpose: allowedTools auto-approves before canUseTool, so nothing
    // is pre-allowed and the exact-name gate below decides every call.
    allowedTools: [],
    disallowedTools: [
      ...READ_ONLY_BUILTINS, ...WRITE_BUILTINS,
      'mcp__jarvis_trading_control', 'mcp__jarvis', 'mcp__jarvis_ui',
      'mcp__jarvis_chrome', 'mcp__jarvis_eyes',
    ],
    systemPrompt,
    cwd,
    settingSources: [],
    model,
    effort,
    maxTurns: 8,
    permissionMode: 'default',
    canUseTool: telegramCanUseTool(onDecision),
  }
}
