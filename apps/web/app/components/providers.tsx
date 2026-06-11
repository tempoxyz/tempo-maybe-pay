'use client'

import {
  getAccessKeyAuthorization,
  getAccessKeyStatusCalls,
  getUrlAccessKeySelection,
  type AccessKeyStatusCall,
} from '@/app/lib/access-key'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Storage as AccountsStorage } from 'accounts'
import { useEffect, useRef, useState } from 'react'
import { numberToHex } from 'viem'
import { createStorage, http, WagmiProvider, createConfig, useAccount } from 'wagmi'
import { tempo, tempoModerato } from 'wagmi/chains'
import { tempoWallet } from 'wagmi/tempo'

type TempoAccountsProvider = {
  getAccessKeyStatus?: (options: {
    address: `0x${string}`
    calls: readonly AccessKeyStatusCall[]
    chainId: 4217 | 42431
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
      authorizeAccessKey: getAccessKeyAuthorization,
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
    const accessKeyChainId = selectedChainId
    const tempoConnector = connector
    const calls = getAccessKeyStatusCalls(accessKeyChainId, railId)
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
          params: [{ ...getAccessKeyAuthorization(accessKeyChainId, railId), chainId: numberToHex(accessKeyChainId) }],
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
