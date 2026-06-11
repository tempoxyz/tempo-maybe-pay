'use client'

import { chainDeployments, normalizeChainId, type ChainId } from '@tempo-maybe-pay/shared'
import { Expiry } from 'accounts'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { numberToHex, parseUnits, toFunctionSelector, type Hex } from 'viem'
import { http, WagmiProvider, createConfig, useAccount } from 'wagmi'
import { tempo, tempoModerato } from 'wagmi/chains'
import { tempoWallet } from 'wagmi/tempo'

const accessKeyLimit = parseUnits('10', 6)
const accessKeyPeriod = 60 * 60 * 24

type AccessKeyDeployment = (typeof chainDeployments)[ChainId] & {
  nft: `0x${string}`
  store: `0x${string}`
}

type AccessKeyStatusCall = { data: Hex; to: `0x${string}` }

function getAccessKeyDeployment(chainId: ChainId): AccessKeyDeployment | undefined {
  const deployment = chainDeployments[chainId]
  if (!deployment.store || !deployment.nft) return undefined
  return deployment as AccessKeyDeployment
}

function getDefaultAccessKeyChainId(): ChainId {
  if (typeof window === 'undefined') return 42431
  return normalizeChainId(new URLSearchParams(window.location.search).get('chainId'))
}

function authorizeAccessKey(chainId = getDefaultAccessKeyChainId()) {
  const deployment = getAccessKeyDeployment(chainId) ?? getAccessKeyDeployment(42431)
  if (!deployment) throw new Error('Tempo Maybe Pay store is not deployed')

  return {
    expiry: Expiry.days(1),
    limits: [{ token: deployment.paymentToken, limit: accessKeyLimit, period: accessKeyPeriod }],
    scopes: [
      { address: deployment.paymentToken, selector: 'approve(address,uint256)' },
      { address: deployment.store, selector: 'placeOrder(bytes32,uint256,uint16,bytes32)' },
      { address: deployment.store, selector: 'redeem(uint256)' },
      { address: deployment.store, selector: 'expireRedemption(uint256)' },
      { address: deployment.nft, selector: 'approve(address,uint256)' },
    ],
  }
}

function accessKeyStatusCalls(chainId: ChainId): readonly AccessKeyStatusCall[] {
  const deployment = getAccessKeyDeployment(chainId)
  if (!deployment) return []

  return [
    { data: toFunctionSelector('approve(address,uint256)'), to: deployment.paymentToken },
    { data: toFunctionSelector('placeOrder(bytes32,uint256,uint16,bytes32)'), to: deployment.store },
    { data: toFunctionSelector('redeem(uint256)'), to: deployment.store },
    { data: toFunctionSelector('expireRedemption(uint256)'), to: deployment.store },
    { data: toFunctionSelector('approve(address,uint256)'), to: deployment.nft },
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
      testnet: true,
    }),
  ],
  multiInjectedProviderDiscovery: false,
  transports: {
    [tempoModerato.id]: http('https://rpc.testnet.tempo.xyz'),
    [tempo.id]: http('https://rpc.tempo.xyz'),
  },
})

function AccessKeyAuthorizer() {
  const { address, chainId, connector, isConnected } = useAccount()
  const attempted = useRef(new Set<string>())

  useEffect(() => {
    const selectedChainId = chainId === 4217 || chainId === 42431 ? chainId : undefined
    if (!isConnected || !address || !selectedChainId || connector?.id !== 'xyz.tempo') return

    const accessKeyChainId: ChainId = selectedChainId
    const tempoConnector = connector
    const calls = accessKeyStatusCalls(accessKeyChainId)
    if (calls.length === 0) return

    const attemptKey = `${tempoConnector.uid}:${address}:${accessKeyChainId}`
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
          params: [{ ...authorizeAccessKey(accessKeyChainId), chainId: numberToHex(accessKeyChainId) }],
        })
      } catch (caught) {
        console.warn('[tempo-maybe-pay] Could not authorize Tempo Wallet access key.', caught)
      }
    }

    void ensureAccessKey()

    return () => {
      cancelled = true
    }
  }, [address, chainId, connector, isConnected])

  return null
}

export function Providers({ children }: Readonly<{ children: React.ReactNode }>) {
  const [queryClient] = useState(() => new QueryClient())

  return (
    <WagmiProvider config={wagmiConfig}>
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
