'use client'

import { chainDeployments } from '@tempo-maybe-pay/shared'
import { Expiry } from 'accounts'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import { parseUnits } from 'viem'
import { http, WagmiProvider, createConfig } from 'wagmi'
import { tempo, tempoModerato } from 'wagmi/chains'
import { tempoWallet } from 'wagmi/tempo'

const accessKeyDeployment = chainDeployments[42431]

const wagmiConfig = createConfig({
  batch: {
    multicall: false,
  },
  ssr: true,
  chains: [tempoModerato, tempo],
  connectors: [
    tempoWallet({
      authorizeAccessKey: () => ({
        expiry: Expiry.days(1),
        limits: [{ token: accessKeyDeployment.paymentToken, limit: parseUnits('10000', 6), period: 60 * 60 * 24 }],
        scopes: [
          { address: accessKeyDeployment.paymentToken, selector: 'approve(address,uint256)' },
          { address: accessKeyDeployment.store, selector: 'placeOrder(bytes32,uint256,uint16,bytes32)' },
          { address: accessKeyDeployment.store, selector: 'redeem(uint256)' },
          { address: accessKeyDeployment.store, selector: 'expireRedemption(uint256)' },
          { address: accessKeyDeployment.nft, selector: 'approve(address,uint256)' },
        ],
      }),
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
