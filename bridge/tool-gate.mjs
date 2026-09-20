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
