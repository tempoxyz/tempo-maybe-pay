export type ChainId = 4217 | 42431

export type Deployment = {
  chainId: ChainId
  name: string
  rpcUrl: string
  wsUrl: string
  explorerUrl: string
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
    rpcUrl: 'https://rpc.testnet.tempo.xyz',
    wsUrl: 'wss://rpc.moderato.tempo.xyz',
    explorerUrl: 'https://explore.testnet.tempo.xyz',
    paymentToken: '0x20c0000000000000000000000000000000000000',
    store: '0x9DDC661dFE977bf20055F67879C9bC4383F7babf',
    nft: '0xe05C61B0cBe2e042902A7EF2C26dCE201f27cf86',
    merchant: '0xd39B4A4b4Ec6e07b6f9B72596D1541bC67F08fD4',
    operator: '0xd39B4A4b4Ec6e07b6f9B72596D1541bC67F08fD4',
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

export function explorerNftUrl(chainId: ChainId, address: string, tokenId: string | number | bigint): string {
  return `${chainDeployments[chainId].explorerUrl}/token/${address}/${tokenId.toString()}`
}
