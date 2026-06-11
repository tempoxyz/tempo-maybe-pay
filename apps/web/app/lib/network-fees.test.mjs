import assert from 'node:assert/strict'
import test from 'node:test'

import { withNetworkFees } from './network-fees.ts'

const paymentToken = '0x20c0000000000000000000000000000000000000'

test('testnet requests Tempo fee-payer sponsorship', () => {
  assert.deepEqual(
    withNetworkFees({ calls: [], chainId: 42431 }, { chainId: 42431, paymentToken }),
    { calls: [], chainId: 42431, feePayer: true },
  )
})

test('mainnet keeps explicit selected fee token', () => {
  assert.deepEqual(
    withNetworkFees({ calls: [], chainId: 4217 }, { chainId: 4217, paymentToken }),
    { calls: [], chainId: 4217, feePayer: false, feeToken: paymentToken },
  )
})
