import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSshArgs } from '../scripts/bot-tunnel.mjs'

test('builds a loopback-only local forward with keepalive and no password prompts', () => {
  const args = buildSshArgs({ JARVIS_BOT_SSH_TARGET: 'root@203.0.113.9' })
  assert.deepEqual(args.slice(0, 3), ['-N', '-L', '127.0.0.1:18080:127.0.0.1:8080'])
  assert.ok(args.includes('BatchMode=yes'))
  assert.ok(args.includes('ExitOnForwardFailure=yes'))
  assert.ok(args.includes('ServerAliveInterval=30'))
  assert.equal(args.at(-1), 'root@203.0.113.9')
})

test('custom ports are honoured and validated', () => {
  const args = buildSshArgs({ JARVIS_BOT_SSH_TARGET: 'u@h', JARVIS_BOT_TUNNEL_PORT: '19000', JARVIS_BOT_REMOTE_PORT: '9090' })
  assert.equal(args[2], '127.0.0.1:19000:127.0.0.1:9090')
  assert.throws(() => buildSshArgs({ JARVIS_BOT_SSH_TARGET: 'u@h', JARVIS_BOT_TUNNEL_PORT: '99999' }), /port/i)
})

test('a missing or malformed target is refused, including option injection', () => {
  for (const bad of [undefined, '', 'host-only', '-oProxyCommand=evil@x', 'a b@host', 'u@h;rm']) {
    assert.throws(() => buildSshArgs({ JARVIS_BOT_SSH_TARGET: bad }), /JARVIS_BOT_SSH_TARGET/)
  }
})
