import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCommand, isAuthorizedChat } from './telegram.mjs'

test('parseCommand recognises "status" with or without a leading slash', () => {
  assert.equal(parseCommand('status'), 'status')
  assert.equal(parseCommand('/status'), 'status')
  assert.equal(parseCommand('  Status  '), 'status')
})

test('parseCommand recognises "halt" with or without a leading slash', () => {
  assert.equal(parseCommand('halt'), 'halt')
  assert.equal(parseCommand('/halt'), 'halt')
  assert.equal(parseCommand('HALT'), 'halt')
})

test('parseCommand reports "unknown" for anything else', () => {
  assert.equal(parseCommand('hello'), 'unknown')
  assert.equal(parseCommand(''), 'unknown')
  assert.equal(parseCommand(undefined), 'unknown')
})

test('isAuthorizedChat matches the configured chat id exactly', () => {
  assert.equal(isAuthorizedChat(12345, '12345'), true)
  assert.equal(isAuthorizedChat('12345', '12345'), true)
  assert.equal(isAuthorizedChat(99999, '12345'), false)
})

test('isAuthorizedChat rejects a missing chat id', () => {
  assert.equal(isAuthorizedChat(undefined, '12345'), false)
  assert.equal(isAuthorizedChat(null, '12345'), false)
})
