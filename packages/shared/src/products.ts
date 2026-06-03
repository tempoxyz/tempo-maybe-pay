export type Product = {
  id: number
  name: string
  tagline: string
  description: string
  basePrice: bigint
  maxSupply: number
  image: string
  accent: string
}

export const products = [
  {
    id: 1,
    name: 'Payment Lane Pass',
    tagline: 'Reserved blockspace, bottled.',
    description: 'A commemorative pass for payments that do not wait behind ordinary app traffic.',
    basePrice: 10_000_000n,
    maxSupply: 500,
    image: '/products/payment-lane-pass.svg',
    accent: '#1f7a8c',
  },
  {
    id: 2,
    name: 'Moderato Mint',
    tagline: 'Testnet-native shine.',
    description: 'A testnet artifact from the faster side of checkout experimentation.',
    basePrice: 5_000_000n,
    maxSupply: 500,
    image: '/products/moderato-mint.svg',
    accent: '#8a5a22',
  },
  {
    id: 3,
    name: 'PathUSD Proof',
    tagline: 'Stable escrow, unstable fate.',
    description: 'A payment proof for orders where expected cost and realized cost take different paths.',
    basePrice: 2_500_000n,
    maxSupply: 500,
    image: '/products/pathusd-proof.svg',
    accent: '#385f2d',
  },
  {
    id: 4,
    name: 'MaybePay Receipt',
    tagline: 'Paid maybe. Minted definitely.',
    description: 'A receipt NFT for the cleanest kind of gamble: the item arrives either way.',
    basePrice: 1_000_000n,
    maxSupply: 1000,
    image: '/products/maybepay-receipt.svg',
    accent: '#7149a8',
  },
] as const satisfies readonly Product[]

export function getProduct(productId: number): Product | undefined {
  return products.find((product) => product.id === productId)
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

