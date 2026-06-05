'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Storage as AccountsStorage } from 'accounts'
import { useState } from 'react'
import { createStorage, http, WagmiProvider, createConfig } from 'wagmi'
import { tempo, tempoModerato } from 'wagmi/chains'
import { tempoWallet } from 'wagmi/tempo'

const wagmiConfig = createConfig({
  batch: {
    multicall: false,
  },
  chains: [tempoModerato, tempo],
  connectors: [
    tempoWallet({
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

export function Providers({ children }: Readonly<{ children: React.ReactNode }>) {
  const [queryClient] = useState(() => new QueryClient())

  return (
    <WagmiProvider config={wagmiConfig} reconnectOnMount>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  )
}

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig
  }
}
