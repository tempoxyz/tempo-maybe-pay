import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      context.parentURL?.includes('/packages/shared/src/') &&
      specifier.startsWith('./') &&
      !specifier.endsWith('.ts')
    ) {
      return nextResolve(`${specifier}.ts`, context)
    }

    return nextResolve(specifier, context)
  },
})

const {
  accessKeyLimit,
  ensureTempoAccessKey,
  getAccessKeyAuthorization,
  getRememberedAccessKeyLimit,
} = await import('./access-key.ts')

const address = '0x1111111111111111111111111111111111111111'
const highLimit = 200_000_000n

function installLocalStorage() {
  const store = new Map()
  globalThis.window = {
    localStorage: {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => {
        store.set(key, String(value))
      },
    },
  }
}

test.afterEach(() => {
  delete globalThis.window
})

test('access key authorization defaults to 10 pathUSD per day', () => {
  const authorization = getAccessKeyAuthorization(42431, 'pathusd')
  assert.equal(authorization.limits[0].limit, accessKeyLimit)
  assert.equal(authorization.limits[0].period, 60 * 60 * 24)
})

test('checkout can request an access key limit that covers larger escrow', () => {
  const authorization = getAccessKeyAuthorization(42431, 'pathusd', highLimit)
  assert.equal(authorization.limits[0].limit, highLimit)
})

test('published default key does not request a new authorization', async () => {
  const requests = []
  await ensureTempoAccessKey({
    address,
    chainId: 42431,
    provider: {
      getAccessKeyStatus: async () => 'published',
      request: async (request) => {
        requests.push(request)
      },
    },
    railId: 'pathusd',
  })

  assert.equal(requests.length, 0)
})

test('larger checkout limit is authorized once and then remembered', async () => {
  installLocalStorage()

  const requests = []
  const provider = {
    getAccessKeyStatus: async () => 'published',
    request: async (request) => {
      requests.push(request)
    },
  }

  await ensureTempoAccessKey({
    address,
    chainId: 42431,
    provider,
    railId: 'pathusd',
    requestedLimit: highLimit,
  })
  await ensureTempoAccessKey({
    address,
    chainId: 42431,
    provider,
    railId: 'pathusd',
    requestedLimit: highLimit,
  })

  assert.equal(requests.length, 1)
  assert.equal(requests[0].method, 'wallet_authorizeAccessKey')
  assert.equal(requests[0].params[0].chainId, '0xa5bf')
  assert.equal(requests[0].params[0].limits[0].limit, highLimit)
  assert.equal(getRememberedAccessKeyLimit(address, 42431, 'pathusd'), highLimit)
})
