import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isReadOnlySessionTool, mcpServerOf } from './tool-gate.mjs'

const cases = [
  ['mcp__jarvis_forex__forex_price', true],
  ['mcp__jarvis_forex__anything', false],
  ['mcp__jarvis_backtest__backtest_run2', false],
  ['mcp__jarvis_trading__trading_halt', false],
  ['mcp__jarvis_forex__forex_price ', false],
  ['mcp__jarvis_backtest__backtest_run', true],
  ['mcp__jarvis_trading__trading_status', true],
  ['mcp__jarvis_trading_control__trading_halt', false],
  ['mcp__jarvis_forex_x__anything', false],
  ['mcp__jarvis_forexx__anything', false],
  ['mcp__jarvis__display', false],
  ['mcp__jarvis__', false],
  ['mcp__jarvis_ui__ui_theme', false],
  ['mcp__jarvis_chrome__chrome_navigate', false],
  ['mcp__jarvis_forex', false],
  ['mcp__jarvis_forex__', false],
  ['mcp__other__get_thing', false],
  ['Bash', false],
  ['Read', false],
  ['WebFetch', false],
  ['Task', false],
  ['', false],
  [undefined, false],
  [null, false],
  [42, false],
  [{ toString: () => 'mcp__jarvis_forex__x' }, false],
  [['mcp__jarvis_forex__x'], false],
]

for (const [name, expected] of cases) {
  test(`forceReadOnly gate: ${JSON.stringify(name)} -> ${expected ? 'allow' : 'deny'}`, () => {
    assert.equal(isReadOnlySessionTool(name), expected)
  })
}

test('mcpServerOf tolerates non-strings', () => {
  assert.equal(mcpServerOf(undefined), null)
  assert.equal(mcpServerOf('mcp__a__b'), 'a')
})

test('the bot co-pilot tools are never allowed in the forced read-only (Telegram) session', () => {
  assert.equal(isReadOnlySessionTool('mcp__jarvis_bot__bot_status'), false)
  assert.equal(isReadOnlySessionTool('mcp__jarvis_bot__bot_briefing'), false)
})
