export type ChainId = 4217 | 42431

export type Deployment = {
  chainId: ChainId
  name: string
  rpcUrl: string
  wsUrl: string
  explorerUrl: string
  sponsorUrl?: string
  paymentToken: `0x${string}`
  store?: `0x${string}`
  nft?: `0x${string}`
  merchant?: `0x${string}`
  operator?: `0x${string}`
}

export const chainDeployments = {
  42431: {
    chainId: 42431,
    name: 'Tempo Testnet',
    rpcUrl: 'https://rpc.moderato.tempo.xyz',
    wsUrl: 'wss://rpc.moderato.tempo.xyz',
    explorerUrl: 'https://explore.testnet.tempo.xyz',
    sponsorUrl: 'https://sponsor.moderato.tempo.xyz',
    paymentToken: '0x20c0000000000000000000000000000000000000',
    store: '0x93Bde6cfc058230783211fdF2A80B872B5dEB4A2',
    nft: '0xCEF460cb161fe30c2FE0526164374BF992A627C4',
    merchant: '0xb83423C6063e24788a8990aA77638A41BA043541',
    operator: '0xCdf374527991264A77073D83A6781eD6A121722B',
  },
  4217: {
    chainId: 4217,
    name: 'Tempo Mainnet',
    rpcUrl: 'https://rpc.tempo.xyz',
    wsUrl: 'wss://rpc.tempo.xyz',
    explorerUrl: 'https://explore.tempo.xyz',
    paymentToken: '0x20c0000000000000000000000000000000000000',
  },
} as const satisfies Record<ChainId, Deployment>

export function normalizeChainId(value: string | number | null | undefined): ChainId {
  const parsed = typeof value === 'number' ? value : value ? Number(value) : 42431
  return parsed === 4217 ? 4217 : 42431
}

export function getDeployment(chainId: string | number | null | undefined): Deployment {
  return chainDeployments[normalizeChainId(chainId)]
}

export function explorerTxUrl(chainId: ChainId, hash: string): string {
  return `${chainDeployments[chainId].explorerUrl}/tx/${hash}`
}

export function explorerAddressUrl(chainId: ChainId, address: string): string {
  return `${chainDeployments[chainId].explorerUrl}/address/${address}`
}

