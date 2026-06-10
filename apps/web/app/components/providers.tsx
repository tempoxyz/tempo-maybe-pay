'use client'

import { chainDeployments } from '@tempo-maybe-pay/shared'
import { Expiry } from 'accounts'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { numberToHex, parseUnits, toFunctionSelector, type Hex } from 'viem'
import { http, WagmiProvider, createConfig, useAccount } from 'wagmi'
import { tempo, tempoModerato } from 'wagmi/chains'
import { tempoWallet } from 'wagmi/tempo'

const accessKeyChainId = 42431
const accessKeyChainIdHex = numberToHex(accessKeyChainId)
const accessKeyDeployment = chainDeployments[accessKeyChainId]

function authorizeAccessKey() {
  return {
    expiry: Expiry.days(1),
    limits: [{ token: accessKeyDeployment.paymentToken, limit: parseUnits('10000', 6), period: 60 * 60 * 24 }],
    scopes: [
      { address: accessKeyDeployment.paymentToken, selector: 'approve(address,uint256)' },
      { address: accessKeyDeployment.store, selector: 'placeOrder(bytes32,uint256,uint16,bytes32)' },
      { address: accessKeyDeployment.store, selector: 'redeem(uint256)' },
      { address: accessKeyDeployment.store, selector: 'expireRedemption(uint256)' },
      { address: accessKeyDeployment.nft, selector: 'approve(address,uint256)' },
    ],
  }
}

const accessKeyStatusCalls = [
  { data: toFunctionSelector('approve(address,uint256)'), to: accessKeyDeployment.paymentToken },
  { data: toFunctionSelector('placeOrder(bytes32,uint256,uint16,bytes32)'), to: accessKeyDeployment.store },
  { data: toFunctionSelector('redeem(uint256)'), to: accessKeyDeployment.store },
  { data: toFunctionSelector('expireRedemption(uint256)'), to: accessKeyDeployment.store },
  { data: toFunctionSelector('approve(address,uint256)'), to: accessKeyDeployment.nft },
] satisfies readonly { data: Hex; to: `0x${string}` }[]

type TempoAccountsProvider = {
  getAccessKeyStatus?: (options: {
    address: `0x${string}`
    calls: typeof accessKeyStatusCalls
    chainId: typeof accessKeyChainId
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
    if (!isConnected || !address || chainId !== accessKeyChainId || connector?.id !== 'xyz.tempo') return

    const attemptKey = `${connector.uid}:${address}:${chainId}`
    if (attempted.current.has(attemptKey)) return
    attempted.current.add(attemptKey)

    const accountAddress = address
    let cancelled = false

    async function ensureAccessKey() {
      try {
        if (!connector?.getProvider) return
        const provider = (await connector.getProvider()) as TempoAccountsProvider
        const status = await provider.getAccessKeyStatus?.({
          address: accountAddress,
          calls: accessKeyStatusCalls,
          chainId: accessKeyChainId,
        })

        if (cancelled || status === 'pending' || status === 'published') return

        await provider.request({
          method: 'wallet_authorizeAccessKey',
          params: [{ ...authorizeAccessKey(), chainId: accessKeyChainIdHex }],
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
