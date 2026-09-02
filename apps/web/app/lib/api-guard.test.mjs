import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ApiError,
  apiErrorResponse,
  clientKeyFor,
  enforceRateLimit,
  requireOperatorAuthorization,
  resetRateLimits,
  singleFlight,
} from './api-guard.ts'

const VALID_KEY = 'a'.repeat(48)

function requestWith(headers = {}) {
  return new Request('https://example.test/api/tokens/1/redeem', { headers, method: 'POST' })
}

test('requireOperatorAuthorization fails closed when the secret is unset', () => {
  delete process.env.MAYBEPAY_OPERATOR_API_KEY
  const response = requireOperatorAuthorization(requestWith({ authorization: 'Bearer undefined' }))
  assert.ok(response, 'expected the request to be rejected')
  assert.equal(response.status, 503)
})

test('requireOperatorAuthorization rejects a secret that is too short to be meaningful', () => {
  process.env.MAYBEPAY_OPERATOR_API_KEY = 'short'
  const response = requireOperatorAuthorization(requestWith({ authorization: 'Bearer short' }))
  assert.ok(response)
  assert.equal(response.status, 503)
})

test('requireOperatorAuthorization accepts the credential from either header', () => {
  process.env.MAYBEPAY_OPERATOR_API_KEY = VALID_KEY
  assert.equal(requireOperatorAuthorization(requestWith({ authorization: `Bearer ${VALID_KEY}` })), null)
  assert.equal(requireOperatorAuthorization(requestWith({ authorization: `bearer   ${VALID_KEY}  ` })), null)
  assert.equal(requireOperatorAuthorization(requestWith({ 'x-maybepay-operator-key': VALID_KEY })), null)
})

test('requireOperatorAuthorization rejects missing, wrong and prefix-matching credentials', () => {
  process.env.MAYBEPAY_OPERATOR_API_KEY = VALID_KEY
  for (const headers of [
    {},
    { authorization: 'Bearer' },
    { authorization: `Basic ${VALID_KEY}` },
    { authorization: `Bearer ${'a'.repeat(47)}` },
    { authorization: `Bearer ${VALID_KEY}x` },
    { 'x-maybepay-operator-key': 'b'.repeat(48) },
  ]) {
    const response = requireOperatorAuthorization(requestWith(headers))
    assert.ok(response, `expected rejection for ${JSON.stringify(headers)}`)
    assert.equal(response.status, 401)
  }
})

test('enforceRateLimit allows the quota then answers 429 with Retry-After', () => {
  resetRateLimits()
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal(enforceRateLimit('bucket', 3, 60_000), null, `attempt ${attempt} should pass`)
  }

  const blocked = enforceRateLimit('bucket', 3, 60_000)
  assert.ok(blocked)
  assert.equal(blocked.status, 429)
  assert.ok(Number(blocked.headers.get('Retry-After')) > 0)

  // Buckets are independent.
  assert.equal(enforceRateLimit('other-bucket', 3, 60_000), null)
})

test('enforceRateLimit starts a fresh window once the old one elapses', async () => {
  resetRateLimits()
  // The window must be comfortably longer than one millisecond: Date.now() has
  // millisecond granularity, so a 1 ms window can expire between two adjacent
  // synchronous calls and the assertion below would race.
  const windowMs = 40
  assert.equal(enforceRateLimit('window', 1, windowMs), null)
  const blocked = enforceRateLimit('window', 1, windowMs)
  assert.ok(blocked, 'second call inside the window must be rejected')
  assert.equal(blocked.status, 429)

  await new Promise((resolve) => setTimeout(resolve, windowMs + 10))
  assert.equal(enforceRateLimit('window', 1, windowMs), null, 'a new window must be allowed')
})

test('clientKeyFor prefers the leftmost forwarded hop and degrades to a constant', () => {
  assert.equal(clientKeyFor(requestWith({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' })), '203.0.113.7')
  assert.equal(clientKeyFor(requestWith({ 'x-real-ip': '203.0.113.9' })), '203.0.113.9')
  assert.equal(clientKeyFor(requestWith()), 'unknown')
})

test('singleFlight collapses concurrent identical work into one execution', async () => {
  let invocations = 0
  const operation = async () => {
    invocations += 1
    await new Promise((resolve) => setTimeout(resolve, 5))
    return invocations
  }

  const results = await Promise.all([
    singleFlight('epoch:4217', operation),
    singleFlight('epoch:4217', operation),
    singleFlight('epoch:4217', operation),
  ])

  assert.equal(invocations, 1, 'concurrent callers must share one execution')
  assert.deepEqual(results, [1, 1, 1])

  // A later call runs again: the entry is released after settling.
  assert.equal(await singleFlight('epoch:4217', operation), 2)
})

test('singleFlight shares rejections and does not poison the key', async () => {
  let attempts = 0
  const failing = async () => {
    attempts += 1
    throw new Error('boom')
  }

  const settled = await Promise.allSettled([
    singleFlight('failing', failing),
    singleFlight('failing', failing),
  ])
  assert.equal(attempts, 1)
  assert.deepEqual(
    settled.map(({ status }) => status),
    ['rejected', 'rejected'],
  )

  // The key is usable again after the failure.
  assert.equal(await singleFlight('failing', async () => 'recovered'), 'recovered')
})

test('singleFlight isolates distinct keys', async () => {
  const [first, second] = await Promise.all([
    singleFlight('a', async () => 'a'),
    singleFlight('b', async () => 'b'),
  ])
  assert.equal(first, 'a')
  assert.equal(second, 'b')
})

test('apiErrorResponse returns ApiError messages and hides everything else', async () => {
  const deliberate = apiErrorResponse(new ApiError('Invalid buyer'), 'Failed', 'test')
  assert.equal(deliberate.status, 400)
  assert.equal(await deliberate.text(), 'Invalid buyer')

  const custom = apiErrorResponse(new ApiError('Store is not deployed', 503), 'Failed', 'test')
  assert.equal(custom.status, 503)

  // Internal failures must not reach the caller: this message embeds an RPC URL
  // and a private-key environment variable name, exactly what used to leak.
  const leaky = new Error('HTTP request failed: https://rpc.internal.tempo.xyz key=MAYBEPAY_PROCESSOR_PRIVATE_KEY')
  const generic = apiErrorResponse(leaky, 'Failed to redeem NFT', 'test')
  assert.equal(generic.status, 500)
  const body = await generic.text()
  assert.equal(body, 'Failed to redeem NFT')
  assert.ok(!body.includes('rpc.internal.tempo.xyz'))
  assert.ok(!body.includes('MAYBEPAY_PROCESSOR_PRIVATE_KEY'))

  // Non-Error throwables are handled too.
  const thrownString = apiErrorResponse('raw string', 'Failed', 'test')
  assert.equal(thrownString.status, 500)
  assert.equal(await thrownString.text(), 'Failed')
})
