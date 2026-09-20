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
 * The only servers a `forceReadOnly` session (the Telegram chat) may touch:
 * cached prices, backtests and trading status. Deliberately excludes
 * jarvis_trading_control — halting stays an explicit /halt command — and every
 * built-in, browser, camera, HUD and third-party server.
 */
export const READ_ONLY_SESSION_SERVERS = new Set(['jarvis_forex', 'jarvis_backtest', 'jarvis_trading'])

/** Exact server match AND a non-empty tool part; everything else is denied. */
export function isReadOnlySessionTool(name) {
  const server = mcpServerOf(name)
  return server !== null && READ_ONLY_SESSION_SERVERS.has(server) && mcpToolOf(name) !== ''
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
