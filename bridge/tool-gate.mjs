/**
 * Pure pieces of the tool gate, split out of server.mjs (which starts a
 * server on import) so the read-only-session allowlist can be unit tested.
 */

/** MCP tools arrive as `mcp__<server>__<tool>`. Non-strings have no server. */
export const mcpServerOf = (toolName) =>
  typeof toolName === 'string' && toolName.startsWith('mcp__') ? toolName.split('__')[1] : null

/** The tool half, which can itself contain underscores: `mcp__x__a__b` -> `a__b`. */
export const mcpToolOf = (toolName) => toolName.split('__').slice(2).join('__')

/**
 * The only tools a `forceReadOnly` session (the Telegram chat) may call:
 * a cached price, a backtest and trading status — EXACT full names, not
 * servers, so a tool added to one of those servers later stays denied until it
 * is listed here on purpose. Deliberately excludes trading_halt (halting stays
 * an explicit /halt command) and every built-in, browser, camera, HUD and
 * third-party tool. bridge/telegram-session.test.mjs fails if the servers
 * expose anything else.
 */
export const READ_ONLY_SESSION_TOOLS = new Set([
  'mcp__jarvis_forex__forex_price',
  'mcp__jarvis_backtest__backtest_run',
  'mcp__jarvis_trading__trading_status',
])

/** Exact match only; everything else (including non-strings) is denied. */
export function isReadOnlySessionTool(name) {
  return typeof name === 'string' && READ_ONLY_SESSION_TOOLS.has(name)
}

/**
 * Both spellings of every renamed built-in are listed on purpose. The SDK
 * presents several tools to the model under newer names — Task is Agent,
 * BashOutput is TaskOutput, KillShell is TaskStop, and the MCP resource tools
 * gained a "Tool" suffix — so a set holding only the old names never matches
 * and the tool falls through to the write branch, which is the opposite of
 * what these lists mean. Keep both until the old names are certainly gone.
 */
export const READ_ONLY_BUILTINS = new Set([
  'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite',
  'Task', 'Agent', 'ToolSearch',
  'ListMcpResources', 'ListMcpResourcesTool',
  'ReadMcpResource', 'ReadMcpResourceTool',
  'BashOutput', 'TaskOutput',
])
export const WRITE_BUILTINS = new Set([
  'Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
  'KillShell', 'TaskStop',
])
