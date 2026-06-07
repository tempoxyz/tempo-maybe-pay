export type ChainId = 4217 | 42431
export type PaymentRailId = 'pathusd' | 'usdc'

export type PaymentRail = {
  id: PaymentRailId
  label: string
  paymentToken: `0x${string}`
  symbol: string
  store?: `0x${string}`
  nft?: `0x${string}`
  merchant?: `0x${string}`
  operator?: `0x${string}`
}

export type ChainDeployment = {
  chainId: ChainId
  defaultRailId: PaymentRailId
  name: string
  rpcUrl: string
  wsUrl: string
  explorerUrl: string
  rails: Record<PaymentRailId, PaymentRail>
}

export type Deployment = ChainDeployment & PaymentRail & { railId: PaymentRailId }

export const chainDeployments = {
  42431: {
    chainId: 42431,
    defaultRailId: 'pathusd',
    name: 'Tempo Testnet',
    rpcUrl: 'https://rpc.testnet.tempo.xyz',
    wsUrl: 'wss://rpc.moderato.tempo.xyz',
    explorerUrl: 'https://explore.testnet.tempo.xyz',
    rails: {
      pathusd: {
        id: 'pathusd',
        label: 'pathUSD',
        symbol: 'pathUSD',
        paymentToken: '0x20c0000000000000000000000000000000000000',
        store: '0x50Fe68c6BF1FC8311252F86701A54F6C753D691D',
        nft: '0x47926a61023B4A99de3F8958b4F168e8aB868Ee3',
        merchant: '0xd39B4A4b4Ec6e07b6f9B72596D1541bC67F08fD4',
        operator: '0xd39B4A4b4Ec6e07b6f9B72596D1541bC67F08fD4',
      },
      usdc: {
        id: 'usdc',
        label: 'USDC.e',
        symbol: 'USDC.e',
        paymentToken: '0x20c0000000000000000000009e8d7eb59b783726',
        store: '0xCd4A483924aB8711F094C2cE351681F691069D34',
        nft: '0x95f4beAB8Db934Dfb71F0D07fe794099D3F82b27',
        merchant: '0xd39B4A4b4Ec6e07b6f9B72596D1541bC67F08fD4',
        operator: '0xd39B4A4b4Ec6e07b6f9B72596D1541bC67F08fD4',
      },
    },
  },
  4217: {
    chainId: 4217,
    defaultRailId: 'pathusd',
    name: 'Tempo Mainnet',
    rpcUrl: 'https://rpc.tempo.xyz',
    wsUrl: 'wss://rpc.tempo.xyz',
    explorerUrl: 'https://explore.tempo.xyz',
    rails: {
      pathusd: {
        id: 'pathusd',
        label: 'pathUSD',
        symbol: 'pathUSD',
        paymentToken: '0x20c0000000000000000000000000000000000000',
        store: '0x567A1CBdb1fb304c799d1130f3675B58E923e2C6',
        nft: '0x33D45470110aA62F06D97588205fe413a44eFE44',
        merchant: '0xd39B4A4b4Ec6e07b6f9B72596D1541bC67F08fD4',
        operator: '0xd39B4A4b4Ec6e07b6f9B72596D1541bC67F08fD4',
      },
      usdc: {
        id: 'usdc',
        label: 'USDC.e',
        symbol: 'USDC.e',
        paymentToken: '0x20c000000000000000000000b9537d11c60e8b50',
        store: '0xDD7c855e521B9371aB7c7d2166964b69D239315A',
        nft: '0x64c0c6305b4D3C9290C3412374f6A455EDFDdcd7',
        merchant: '0xd39B4A4b4Ec6e07b6f9B72596D1541bC67F08fD4',
        operator: '0xd39B4A4b4Ec6e07b6f9B72596D1541bC67F08fD4',
      },
    },
  },
} as const satisfies Record<ChainId, ChainDeployment>

export function normalizeChainId(value: string | number | null | undefined): ChainId {
  const parsed = typeof value === 'number' ? value : value ? Number(value) : 4217
  return parsed === 4217 ? 4217 : 42431
}

export function normalizePaymentRailId(value: string | null | undefined): PaymentRailId {
  return value?.toLowerCase() === 'usdc' ? 'usdc' : 'pathusd'
}

export function getDeployment(
  chainId: string | number | null | undefined,
  railIdInput?: string | null,
): Deployment {
  const chain = chainDeployments[normalizeChainId(chainId)]
  const railId = normalizePaymentRailId(railIdInput)
  return {
    ...chain,
    ...chain.rails[railId],
    railId,
  }
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
