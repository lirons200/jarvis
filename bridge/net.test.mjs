import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sameOrigin } from './net.mjs'

test('sameOrigin matches identical scheme, host, and port', () => {
  const a = new URL('https://api-fxpractice.oanda.com/v3/accounts/123/orders')
  const b = new URL('https://api-fxpractice.oanda.com/v3/accounts/123/pricing')
  assert.equal(sameOrigin(a, b), true)
})

test('sameOrigin rejects a different host', () => {
  const a = new URL('https://api-fxpractice.oanda.com/orders')
  const b = new URL('https://attacker.example.com/orders')
  assert.equal(sameOrigin(a, b), false)
})

test('sameOrigin rejects a scheme downgrade (https to http)', () => {
  const a = new URL('https://api-fxpractice.oanda.com/orders')
  const b = new URL('http://api-fxpractice.oanda.com/orders')
  assert.equal(sameOrigin(a, b), false)
})

test('sameOrigin rejects a different port', () => {
  const a = new URL('https://api-fxpractice.oanda.com:443/orders')
  const b = new URL('https://api-fxpractice.oanda.com:8443/orders')
  assert.equal(sameOrigin(a, b), false)
})
