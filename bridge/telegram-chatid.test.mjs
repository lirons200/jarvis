import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isValidChatId } from './telegram.mjs'

test('isValidChatId accepts only numeric private chat ids', () => {
  assert.equal(isValidChatId('123456789'), true)
  assert.equal(isValidChatId(' 42 '), true)
  for (const bad of ['', 'undefined', 'NaN', '-1001234', '12abc', '1.5', undefined, null, 5]) {
    assert.equal(isValidChatId(bad), false, String(bad))
  }
})
