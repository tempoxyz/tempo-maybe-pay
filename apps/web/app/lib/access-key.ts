'use client'

import {
  getDeployment,
  normalizeChainId,
  normalizePaymentRailId,
  tip20Abi,
  type ChainId,
  type Deployment,
  type PaymentRailId,
} from '@tempo-maybe-pay/shared'
import { Expiry } from 'accounts'
import { encodeFunctionData, parseUnits, toFunctionSelector, zeroHash, type Hex } from 'viem'

export const accessKeyLimit = parseUnits('10', 6)
export const accessKeyPeriod = 60 * 60 * 24

type AccessKeyDeployment = Deployment & {
  nft: `0x${string}`
  store: `0x${string}`
}

export type AccessKeyStatusCall = { data: Hex; to: `0x${string}` }

export function getUrlAccessKeySelection(): { chainId: ChainId; railId: PaymentRailId } {
  if (typeof window === 'undefined') return { chainId: 4217, railId: 'pathusd' }
  const params = new URLSearchParams(window.location.search)
  return {
    chainId: normalizeChainId(params.get('chainId')),
    railId: normalizePaymentRailId(params.get('rail')),
  }
}

function getAccessKeyDeployment(chainId: ChainId, railId: PaymentRailId): AccessKeyDeployment | undefined {
  const deployment = getDeployment(chainId, railId)
  if (!deployment.store || !deployment.nft) return undefined
  return deployment as AccessKeyDeployment
}

export function getAccessKeyAuthorization(
  chainId = getUrlAccessKeySelection().chainId,
  railId = getUrlAccessKeySelection().railId,
) {
  const deployment = getAccessKeyDeployment(chainId, railId) ?? getAccessKeyDeployment(chainId, 'pathusd')
  if (!deployment) throw new Error('Tempo Maybe Pay store is not deployed')

  return {
    expiry: Expiry.days(1),
    limits: [{ token: deployment.paymentToken, limit: accessKeyLimit, period: accessKeyPeriod }],
    scopes: [
      {
        address: deployment.paymentToken,
        recipients: [deployment.store],
        selector: 'transferWithMemo(address,uint256,bytes32)',
      },
      { address: deployment.store, selector: 'redeem(uint256)' },
      { address: deployment.store, selector: 'expireRedemption(uint256)' },
    ],
  }
}

export function getAccessKeyStatusCalls(
  chainId: ChainId,
  railId: PaymentRailId,
): readonly AccessKeyStatusCall[] {
  const deployment = getAccessKeyDeployment(chainId, railId)
  if (!deployment) return []

  return [
    {
      data: encodeFunctionData({
        abi: tip20Abi,
        args: [deployment.store, 0n, zeroHash],
        functionName: 'transferWithMemo',
      }),
      to: deployment.paymentToken,
    },
    { data: toFunctionSelector('redeem(uint256)'), to: deployment.store },
    { data: toFunctionSelector('expireRedemption(uint256)'), to: deployment.store },
  ]
}
