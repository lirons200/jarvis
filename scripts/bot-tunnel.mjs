#!/usr/bin/env node
/**
 * Keeps an SSH tunnel open from this PC to the bot's dashboard, so JARVIS can
 * talk to http://127.0.0.1:18080 instead of sending an unauthenticated
 * dashboard over the open internet. Key-based auth only (BatchMode).
 *   JARVIS_BOT_SSH_TARGET=root@your.vps  npm run bot:tunnel
 * Then set JARVIS_BOT_DASHBOARD_URL=http://127.0.0.1:18080
 */
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const TARGET_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*@[A-Za-z0-9_.-]+$/

function port(value, fallback) {
  if (value === undefined || value === '') return fallback
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`invalid port: ${value}`)
  return n
}

export function buildSshArgs(env) {
  const target = env.JARVIS_BOT_SSH_TARGET
  if (typeof target !== 'string' || !TARGET_RE.test(target)) {
    throw new Error('JARVIS_BOT_SSH_TARGET must look like user@host')
  }
  const local = port(env.JARVIS_BOT_TUNNEL_PORT, 18080)
  const remote = port(env.JARVIS_BOT_REMOTE_PORT, 8080)
  return [
    '-N', '-L', `127.0.0.1:${local}:127.0.0.1:${remote}`,
    '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3',
    '-o', 'ExitOnForwardFailure=yes', '-o', 'BatchMode=yes',
    target,
  ]
}

async function main() {
  const args = buildSshArgs(process.env)
  let delay = 5000
  let stopping = false
  let current = null
  // Registered once, not per reconnect: stop the loop and take the running ssh down with us.
  const stop = () => {
    stopping = true
    current?.kill()
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  while (!stopping) {
    const started = Date.now()
    console.log(`[bot-tunnel] ssh ${args.join(' ')}`)
    await new Promise((resolve) => {
      const child = spawn('ssh', args, { stdio: 'inherit' })
      current = child
      child.on('exit', resolve)
      child.on('error', resolve)
    })
    current = null
    if (stopping) break
    delay = Date.now() - started > 60_000 ? 5000 : Math.min(delay * 2, 60_000)
    console.log(`[bot-tunnel] tunnel closed; reconnecting in ${delay / 1000}s`)
    await new Promise((r) => setTimeout(r, delay))
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(`[bot-tunnel] ${err.message}`)
    process.exit(1)
  })
}
