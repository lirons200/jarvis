import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isSlashCommand, chunkMessage, createRateLimiter, createChatDispatcher, isAuthorizedMessage,
} from './telegram.mjs'

test('isAuthorizedMessage requires private chat and matching chat and sender ids', () => {
  const ok = { chat: { id: 5, type: 'private' }, from: { id: 5 } }
  assert.equal(isAuthorizedMessage(ok, '5'), true)
  // group whose id matches but sender differs
  assert.equal(isAuthorizedMessage({ chat: { id: 5, type: 'group' }, from: { id: 9 } }, '5'), false)
  // group with matching ids still refused: not private
  assert.equal(isAuthorizedMessage({ chat: { id: 5, type: 'supergroup' }, from: { id: 5 } }, '5'), false)
  // private chat but different sender
  assert.equal(isAuthorizedMessage({ chat: { id: 5, type: 'private' }, from: { id: 9 } }, '5'), false)
  assert.equal(isAuthorizedMessage({ chat: { id: 5, type: 'private' } }, '5'), false)
  assert.equal(isAuthorizedMessage({ chat: { id: 9, type: 'private' }, from: { id: 5 } }, '5'), false)
  assert.equal(isAuthorizedMessage(undefined, '5'), false)
})

test('isSlashCommand flags leading-slash text only', () => {
  assert.equal(isSlashCommand('/foo'), true)
  assert.equal(isSlashCommand('  /foo'), true)
  assert.equal(isSlashCommand('hello /foo'), false)
  assert.equal(isSlashCommand(undefined), false)
})

test('chunkMessage leaves short text alone and returns [] for empty', () => {
  assert.deepEqual(chunkMessage('hi'), ['hi'])
  assert.deepEqual(chunkMessage(''), [])
  assert.deepEqual(chunkMessage(undefined), [])
})

test('chunkMessage never exceeds the limit and loses no words', () => {
  const text = Array.from({ length: 2000 }, (_, i) => `word${i}`).join(' ')
  const chunks = chunkMessage(text, 100)
  assert.ok(chunks.length > 1)
  for (const c of chunks) assert.ok(c.length <= 100 && c.length > 0)
  assert.equal(chunks.join(' '), text)
})

test('chunkMessage prefers paragraph breaks', () => {
  const a = 'a'.repeat(60)
  const b = 'b'.repeat(60)
  assert.deepEqual(chunkMessage(`${a}\n\n${b}`, 100), [a, b])
})

test('chunkMessage hard-cuts an unbroken run and respects the 4096 default', () => {
  const chunks = chunkMessage('x'.repeat(10_000))
  assert.deepEqual(chunks.map((c) => c.length), [4096, 4096, 1808])
})

test('chunkMessage does not split a surrogate pair', () => {
  const chunks = chunkMessage('😀'.repeat(10), 5)
  for (const c of chunks) assert.doesNotMatch(c, /^[\udc00-\udfff]|[\ud800-\udbff]$/)
  assert.equal(chunks.join(''), '😀'.repeat(10))
})

test('createRateLimiter allows max per window then recovers', () => {
  const l = createRateLimiter({ max: 2, windowMs: 1000 })
  assert.equal(l.tryAcquire(0), true)
  assert.equal(l.tryAcquire(100), true)
  assert.equal(l.tryAcquire(200), false)
  assert.equal(l.tryAcquire(1001), true)
  assert.equal(l.tryAcquire(1002), false)
})

const limiter = () => createRateLimiter({ max: 100, windowMs: 1000 })

test('dispatcher returns the handler reply and passes text trimmed but otherwise untouched', async () => {
  let seen
  const d = createChatDispatcher({ handler: async (t) => ((seen = t), ' ok '), limiter: limiter(), timeoutMs: 1000 })
  assert.equal(await d('  $(rm -rf /) `x`  '), 'ok')
  assert.equal(seen, '$(rm -rf /) `x`')
})

test('dispatcher rejects empty and over-long input without calling the handler', async () => {
  let calls = 0
  const d = createChatDispatcher({ handler: async () => (calls++, 'x'), limiter: limiter(), timeoutMs: 1000, maxInput: 10 })
  assert.match(await d('   '), /text/i)
  assert.match(await d('y'.repeat(11)), /too long/)
  assert.equal(calls, 0)
})

test('dispatcher allows only one in-flight request', async () => {
  let release
  const d = createChatDispatcher({
    handler: () => new Promise((r) => (release = r)),
    limiter: limiter(),
    timeoutMs: 1000,
  })
  const first = d('one')
  assert.match(await d('two'), /Still working/)
  release('done')
  assert.equal(await first, 'done')
  const second = d('three')
  await new Promise((r) => setImmediate(r))
  release('again')
  assert.equal(await second, 'again')
})

test("a hung handler's late grace release cannot clear a newer run's busy flag", async () => {
  const releases = []
  const d = createChatDispatcher({
    handler: () => new Promise((r) => releases.push(r)),
    limiter: limiter(),
    timeoutMs: 10,
    graceMs: 30,
  })
  assert.match(await d('one'), /too long/) // times out; handler hangs
  await new Promise((r) => setTimeout(r, 60)) // grace release frees the slot
  const second = d('two')
  await new Promise((r) => setImmediate(r))
  releases[0]('late') // hung first handler finally settles
  assert.match(await d('three'), /Still working/) // second run still holds the slot
  releases[1]('done')
  assert.equal(await second, 'done')
})

test('dispatcher applies the rate limit', async () => {
  const d = createChatDispatcher({
    handler: async () => 'ok',
    limiter: createRateLimiter({ max: 1, windowMs: 60_000 }),
    timeoutMs: 1000,
  })
  assert.equal(await d('a'), 'ok')
  assert.match(await d('b'), /Slow down/)
})

test('dispatcher times out and aborts the signal', async () => {
  let signal
  const d = createChatDispatcher({
    handler: (t, s) =>
      new Promise((_, rej) => {
        signal = s
        s.addEventListener('abort', () => rej(new Error('aborted')))
      }),
    limiter: limiter(),
    timeoutMs: 20,
  })
  assert.match(await d('slow'), /too long/)
  assert.equal(signal.aborted, true)
  // The aborting handler settles, freeing the slot.
  await new Promise((r) => setImmediate(r))
  assert.match(await d('again'), /too long/)
})

test('dispatcher error replies never leak the error message', async () => {
  const d = createChatDispatcher({
    handler: async () => {
      throw new Error('ENOENT C:\\secret\\.env token=abc123')
    },
    limiter: limiter(),
    timeoutMs: 1000,
  })
  const orig = console.error
  console.error = () => {}
  try {
    const reply = await d('hi')
    assert.doesNotMatch(reply, /secret|abc123|ENOENT/)
  } finally {
    console.error = orig
  }
})
