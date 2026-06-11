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
import { encodeFunctionData, numberToHex, parseUnits, toFunctionSelector, zeroHash, type Hex } from 'viem'

export const accessKeyLimit = parseUnits('10', 6)
export const accessKeyPeriod = 60 * 60 * 24
export const accessKeyPolicyVersion = 2

type AccessKeyDeployment = Deployment & {
  nft: `0x${string}`
  store: `0x${string}`
}

export type AccessKeyStatusCall = { data: Hex; to: `0x${string}` }

export type TempoAccessKeyProvider = {
  getAccessKeyStatus?: (options: {
    address: `0x${string}`
    calls: readonly AccessKeyStatusCall[]
    chainId: ChainId
  }) => Promise<'missing' | 'pending' | 'published' | 'expired'>
  request: (request: { method: string; params?: unknown[] }) => Promise<unknown>
}

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
  requestedLimit = accessKeyLimit,
) {
  const deployment = getAccessKeyDeployment(chainId, railId) ?? getAccessKeyDeployment(chainId, 'pathusd')
  if (!deployment) throw new Error('Tempo Maybe Pay store is not deployed')
  const limit = requestedLimit > accessKeyLimit ? requestedLimit : accessKeyLimit

  return {
    expiry: Expiry.days(1),
    limits: [{ token: deployment.paymentToken, limit, period: accessKeyPeriod }],
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

function getAccessKeyStorageKey(address: `0x${string}`, chainId: ChainId, railId: PaymentRailId): string | undefined {
  const deployment = getAccessKeyDeployment(chainId, railId)
  if (!deployment) return undefined
  return [
    'tempo-maybe-pay',
    'access-key',
    `v${accessKeyPolicyVersion}`,
    address.toLowerCase(),
    chainId,
    railId,
    deployment.paymentToken.toLowerCase(),
    deployment.store.toLowerCase(),
  ].join(':')
}

export function getRememberedAccessKeyLimit(
  address: `0x${string}`,
  chainId: ChainId,
  railId: PaymentRailId,
): bigint | undefined {
  if (typeof window === 'undefined') return undefined
  const key = getAccessKeyStorageKey(address, chainId, railId)
  if (!key) return undefined

  try {
    const value = window.localStorage.getItem(key)
    if (!value) return undefined

    try {
      const parsed = JSON.parse(value) as { expiresAt?: unknown; limit?: unknown }
      if (typeof parsed.expiresAt === 'number' && parsed.expiresAt <= Math.floor(Date.now() / 1000)) {
        window.localStorage.removeItem(key)
        return undefined
      }
      return typeof parsed.limit === 'string' ? BigInt(parsed.limit) : undefined
    } catch {
      return BigInt(value)
    }
  } catch {
    return undefined
  }
}

export function rememberAccessKeyLimit(
  address: `0x${string}`,
  chainId: ChainId,
  railId: PaymentRailId,
  requestedLimit = accessKeyLimit,
) {
  if (typeof window === 'undefined') return
  const key = getAccessKeyStorageKey(address, chainId, railId)
  if (!key) return

  try {
    const limit = requestedLimit > accessKeyLimit ? requestedLimit : accessKeyLimit
    window.localStorage.setItem(
      key,
      JSON.stringify({
        expiresAt: Math.floor(Date.now() / 1000) + accessKeyPeriod,
        limit: limit.toString(),
      }),
    )
  } catch {}
}

function rememberedAccessKeyCovers(
  address: `0x${string}`,
  chainId: ChainId,
  railId: PaymentRailId,
  requestedLimit = accessKeyLimit,
): boolean {
  if (requestedLimit <= accessKeyLimit) return true
  const rememberedLimit = getRememberedAccessKeyLimit(address, chainId, railId)
  return rememberedLimit !== undefined && rememberedLimit >= requestedLimit
}

export async function ensureTempoAccessKey({
  address,
  chainId,
  provider,
  railId,
  requestedLimit = accessKeyLimit,
}: {
  address: `0x${string}`
  chainId: ChainId
  provider: TempoAccessKeyProvider
  railId: PaymentRailId
  requestedLimit?: bigint
}): Promise<{ authorized: boolean; status?: 'missing' | 'pending' | 'published' | 'expired' }> {
  const calls = getAccessKeyStatusCalls(chainId, railId)
  if (calls.length === 0) return { authorized: false }

  const status = await provider.getAccessKeyStatus?.({
    address,
    calls,
    chainId,
  })
  const usableStatus = status === 'pending' || status === 'published'
  if (usableStatus && rememberedAccessKeyCovers(address, chainId, railId, requestedLimit)) {
    return { authorized: false, status }
  }

  await provider.request({
    method: 'wallet_authorizeAccessKey',
    params: [{ ...getAccessKeyAuthorization(chainId, railId, requestedLimit), chainId: numberToHex(chainId) }],
  })
  rememberAccessKeyLimit(address, chainId, railId, requestedLimit)
  return { authorized: true, status }
}
