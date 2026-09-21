import { test } from 'node:test'
import assert from 'node:assert/strict'
import { telegramSessionOptions, telegramCanUseTool } from './telegram-session.mjs'
import { READ_ONLY_SESSION_TOOLS } from './tool-gate.mjs'
import { forexServer } from './forex.mjs'
import { backtestServer } from './backtest.mjs'
import { tradingServer } from './trading.mjs'

const opts = () =>
  telegramSessionOptions({ abortController: new AbortController(), systemPrompt: 'p', model: 'm', effort: 'low', cwd: '/x' })

test('telegramSessionOptions has the locked-down shape', () => {
  const o = opts()
  assert.equal(o.strictMcpConfig, true)
  assert.deepEqual(o.tools, [])
  assert.deepEqual(Object.keys(o.mcpServers).sort(), ['jarvis_backtest', 'jarvis_forex', 'jarvis_trading'])
  assert.deepEqual(o.allowedTools, [])
  for (const t of ['Bash', 'Read', 'Write', 'WebFetch', 'Task', 'mcp__jarvis_trading_control', 'mcp__jarvis_ui', 'mcp__jarvis_chrome', 'mcp__jarvis_eyes']) {
    assert.ok(o.disallowedTools.includes(t), `disallowedTools lacks ${t}`)
  }
  assert.deepEqual(o.settingSources, [])
  assert.equal(o.maxTurns, 8)
  assert.equal(o.permissionMode, 'default')
})

test('telegramCanUseTool allows the exact names and denies the rest', async () => {
  const seen = []
  const can = telegramCanUseTool((n, ok) => seen.push([n, ok]))
  for (const n of READ_ONLY_SESSION_TOOLS) assert.deepEqual(await can(n), { behavior: 'allow' })
  for (const n of ['mcp__jarvis_forex__anything', 'mcp__jarvis_trading_control__trading_halt', 'Bash', undefined]) {
    assert.deepEqual(await can(n), { behavior: 'deny', message: 'Not available over Telegram.' })
  }
  assert.equal(seen.length, READ_ONLY_SESSION_TOOLS.size + 4)
})

// Tripwire: a tool added to one of the three servers must be added to the
// allowlist deliberately (and the verify script re-run), or this fails.
test('tools exposed by the three servers equal the exact allowlist', () => {
  const exposed = []
  for (const [name, make] of [['jarvis_forex', forexServer], ['jarvis_backtest', backtestServer], ['jarvis_trading', tradingServer]]) {
    const registered = make().instance?._registeredTools
    assert.ok(registered && typeof registered === 'object', `cannot enumerate tools of ${name} (SDK internals changed)`)
    for (const t of Object.keys(registered)) exposed.push(`mcp__${name}__${t}`)
  }
  assert.deepEqual(exposed.sort(), [...READ_ONLY_SESSION_TOOLS].sort())
})

test('the Telegram session explicitly disallows the bot co-pilot server', () => {
  const o = opts()
  assert.ok(o.disallowedTools.includes('mcp__jarvis_bot'))
  assert.ok(!Object.keys(o.mcpServers).includes('jarvis_bot'))
})
