import type { ChainId } from './chains'

export type Product = {
  id: number
  name: string
  sku: string
  category: string
  tagline: string
  description: string
  prices: Record<ChainId, bigint>
  maxSupply: number
  image: string
  accent: string
  slackEmoji: string
}

export const products = [
  {
    id: 1,
    name: 'Tempo Flight Pass',
    sku: 'TMP-FLY-01',
    category: 'Tempo Low Tier',
    tagline: 'A tiny claim with wings.',
    description: 'A low-variance Tempo NFT for trying the house-bankroll game with a light checkout.',
    prices: {
      4217: 1_000n,
      42431: 1_000_000n,
    },
    maxSupply: 10_000,
    image: '/products/tempo-flight-pass.svg',
    accent: '#4567d8',
    slackEmoji: ':money-with-wings:',
  },
  {
    id: 2,
    name: 'Tempo Dollar Lane',
    sku: 'TMP-DLR-02',
    category: 'Tempo Mid Tier',
    tagline: 'The clean middle lane.',
    description: 'A mid-tier Tempo NFT for testing probabilistic settlement with meaningful variance.',
    prices: {
      4217: 10_000n,
      42431: 10_000_000n,
    },
    maxSupply: 5_000,
    image: '/products/tempo-dollar-lane.svg',
    accent: '#198754',
    slackEmoji: ':dollar:',
  },
  {
    id: 3,
    name: 'Tempo Treasury Bag',
    sku: 'TMP-BAG-03',
    category: 'Tempo High Tier',
    tagline: 'Try the house for size.',
    description: 'A high-tier Tempo NFT for pushing the bankroll and making the cash-out window matter.',
    prices: {
      4217: 100_000n,
      42431: 100_000_000n,
    },
    maxSupply: 1_000,
    image: '/products/tempo-treasury-bag.svg',
    accent: '#a16207',
    slackEmoji: ':moneybag:',
  },
] as const satisfies readonly Product[]

export function getProduct(productId: number): Product | undefined {
  return products.find((product) => product.id === productId)
}

export function getProductPrice(product: Product, chainId: ChainId): bigint {
  return product.prices[chainId]
}

export function formatPathUsd(raw: bigint): string {
  const sign = raw < 0n ? '-' : ''
  const value = raw < 0n ? -raw : raw
  const whole = value / 1_000_000n
  const fraction = value % 1_000_000n
  const fractionString = fraction.toString().padStart(6, '0').replace(/0+$/, '')
  return `${sign}${whole.toString()}${fractionString ? `.${fractionString}` : ''}`
}

export function quoteMaxEscrow(basePrice: bigint, payProbabilityBps: number): bigint {
  if (payProbabilityBps <= 0) throw new Error('payProbabilityBps must be positive')
  const numerator = basePrice * 10_000n
  return (numerator + BigInt(payProbabilityBps) - 1n) / BigInt(payProbabilityBps)
}

export function quoteRedeemValue(basePrice: bigint): bigint {
  return (basePrice * 9_900n) / 10_000n
}
