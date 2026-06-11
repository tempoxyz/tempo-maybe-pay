'use client'

import {
  getDeployment,
  normalizeChainId,
  normalizePaymentRailId,
  type ChainId,
  type Deployment,
  type PaymentRailId,
} from '@tempo-maybe-pay/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Expiry, Storage as AccountsStorage } from 'accounts'
import { useEffect, useRef, useState } from 'react'
import { numberToHex, parseUnits, toFunctionSelector, type Hex } from 'viem'
import { createStorage, http, WagmiProvider, createConfig, useAccount } from 'wagmi'
import { tempo, tempoModerato } from 'wagmi/chains'
import { tempoWallet } from 'wagmi/tempo'

const accessKeyLimit = parseUnits('10', 6)
const accessKeyPeriod = 60 * 60 * 24

type AccessKeyDeployment = Deployment & {
  nft: `0x${string}`
  store: `0x${string}`
}

type AccessKeyStatusCall = { data: Hex; to: `0x${string}` }

function getUrlAccessKeySelection(): { chainId: ChainId; railId: PaymentRailId } {
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

function authorizeAccessKey(
  chainId = getUrlAccessKeySelection().chainId,
  railId = getUrlAccessKeySelection().railId,
) {
  const deployment = getAccessKeyDeployment(chainId, railId) ?? getAccessKeyDeployment(chainId, 'pathusd')
  if (!deployment) throw new Error('Tempo Maybe Pay store is not deployed')

  return {
    expiry: Expiry.days(1),
    limits: [{ token: deployment.paymentToken, limit: accessKeyLimit, period: accessKeyPeriod }],
    scopes: [
      { address: deployment.paymentToken, selector: 'transferWithMemo(address,uint256,bytes32)' },
      { address: deployment.store, selector: 'redeem(uint256)' },
      { address: deployment.store, selector: 'expireRedemption(uint256)' },
    ],
  }
}

function accessKeyStatusCalls(chainId: ChainId, railId: PaymentRailId): readonly AccessKeyStatusCall[] {
  const deployment = getAccessKeyDeployment(chainId, railId)
  if (!deployment) return []

  return [
    { data: toFunctionSelector('transferWithMemo(address,uint256,bytes32)'), to: deployment.paymentToken },
    { data: toFunctionSelector('redeem(uint256)'), to: deployment.store },
    { data: toFunctionSelector('expireRedemption(uint256)'), to: deployment.store },
  ]
}

type TempoAccountsProvider = {
  getAccessKeyStatus?: (options: {
    address: `0x${string}`
    calls: readonly AccessKeyStatusCall[]
    chainId: ChainId
  }) => Promise<'missing' | 'pending' | 'published' | 'expired'>
  request: (request: { method: string; params?: unknown[] }) => Promise<unknown>
}

const wagmiConfig = createConfig({
  batch: {
    multicall: false,
  },
  ssr: true,
  chains: [tempoModerato, tempo],
  connectors: [
    tempoWallet({
      authorizeAccessKey,
      mpp: true,
      storage:
        typeof window === 'undefined'
          ? AccountsStorage.memory({ key: 'tempo-maybe-pay.accounts' })
          : AccountsStorage.idb({ key: 'tempo-maybe-pay.accounts' }),
      testnet: true,
    }),
  ],
  multiInjectedProviderDiscovery: false,
  storage: createStorage({
    key: 'tempo-maybe-pay.wallet',
    storage: typeof window === 'undefined' ? undefined : window.localStorage,
  }),
  transports: {
    [tempoModerato.id]: http('https://rpc.testnet.tempo.xyz'),
    [tempo.id]: http('https://rpc.tempo.xyz'),
  },
})

function AccessKeyAuthorizer() {
  const { address, chainId, connector, isConnected } = useAccount()
  const attempted = useRef(new Set<string>())
  const locationSearch = typeof window === 'undefined' ? '' : window.location.search

  useEffect(() => {
    const selectedChainId = chainId === 4217 || chainId === 42431 ? chainId : undefined
    if (!isConnected || !address || !selectedChainId || connector?.id !== 'xyz.tempo') return

    const { railId } = getUrlAccessKeySelection()
    const accessKeyChainId: ChainId = selectedChainId
    const tempoConnector = connector
    const calls = accessKeyStatusCalls(accessKeyChainId, railId)
    if (calls.length === 0) return

    const attemptKey = `${tempoConnector.uid}:${address}:${accessKeyChainId}:${railId}`
    if (attempted.current.has(attemptKey)) return
    attempted.current.add(attemptKey)

    const accountAddress = address
    let cancelled = false

    async function ensureAccessKey() {
      try {
        if (!tempoConnector.getProvider) return
        const provider = (await tempoConnector.getProvider()) as TempoAccountsProvider
        const status = await provider.getAccessKeyStatus?.({
          address: accountAddress,
          calls,
          chainId: accessKeyChainId,
        })

        if (cancelled || status === 'pending' || status === 'published') return

        await provider.request({
          method: 'wallet_authorizeAccessKey',
          params: [{ ...authorizeAccessKey(accessKeyChainId, railId), chainId: numberToHex(accessKeyChainId) }],
        })
      } catch (caught) {
        console.warn('[tempo-maybe-pay] Could not authorize Tempo Wallet access key.', caught)
      }
    }

    void ensureAccessKey()

    return () => {
      cancelled = true
    }
  }, [address, chainId, connector, isConnected, locationSearch])

  return null
}

export function Providers({ children }: Readonly<{ children: React.ReactNode }>) {
  const [queryClient] = useState(() => new QueryClient())

  return (
    <WagmiProvider config={wagmiConfig} reconnectOnMount>
      <QueryClientProvider client={queryClient}>
        <AccessKeyAuthorizer />
        {children}
      </QueryClientProvider>
    </WagmiProvider>
  )
}

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig
  }
}
