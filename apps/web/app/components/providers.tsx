'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import { http, WagmiProvider, createConfig } from 'wagmi'
import { tempo, tempoModerato } from 'wagmi/chains'
import { tempoWallet, webAuthn } from 'wagmi/tempo'

const wagmiConfig = createConfig({
  batch: {
    multicall: false,
  },
  chains: [tempoModerato, tempo],
  connectors: [
    webAuthn(),
    tempoWallet({
      feePayer: {
        precedence: 'user-first',
        url: 'https://sponsor.moderato.tempo.xyz',
      },
      testnet: true,
    }),
  ],
  multiInjectedProviderDiscovery: false,
  transports: {
    [tempoModerato.id]: http('https://rpc.moderato.tempo.xyz'),
    [tempo.id]: http('https://rpc.tempo.xyz'),
  },
})

export function Providers({ children }: Readonly<{ children: React.ReactNode }>) {
  const [queryClient] = useState(() => new QueryClient())

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  )
}

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig
  }
}
