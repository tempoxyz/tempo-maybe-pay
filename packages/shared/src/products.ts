import { normalizeChainId, type ChainId } from './chains'

export type Product = {
  id: number
  name: string
  sku: string
  category: string
  tagline: string
  description: string
  basePrice: bigint
  maxSupply: number
  image: string
  accent: string
}

const mainnetProducts = [
  {
    id: 1,
    name: 'Tempo Flight Pass',
    sku: 'TMP-FLY-01',
    category: 'Tempo Low Tier',
    tagline: 'A tiny claim with wings.',
    description: 'A low-variance Tempo NFT for trying the house-bankroll game with a light checkout.',
    basePrice: 1_000n,
    maxSupply: 10_000,
    image: '/products/payment-lane-pass.svg',
    accent: '#4567d8',
  },
  {
    id: 2,
    name: 'Tempo Dollar Lane',
    sku: 'TMP-DLR-02',
    category: 'Tempo Mid Tier',
    tagline: 'The clean middle lane.',
    description: 'A mid-tier Tempo NFT for testing probabilistic settlement with meaningful variance.',
    basePrice: 10_000n,
    maxSupply: 5_000,
    image: '/products/pathusd-proof.svg',
    accent: '#198754',
  },
  {
    id: 3,
    name: 'Tempo Treasury Bag',
    sku: 'TMP-BAG-03',
    category: 'Tempo High Tier',
    tagline: 'Try the house for size.',
    description: 'A high-tier Tempo NFT for pushing the bankroll and making the cash-out window matter.',
    basePrice: 100_000n,
    maxSupply: 1_000,
    image: '/products/maybepay-receipt.svg',
    accent: '#a16207',
  },
] as const satisfies readonly Product[]

const testnetProducts = [
  {
    id: 1,
    name: 'Tempo Hoodie',
    sku: 'TMP-HD-01',
    category: 'Apparel',
    tagline: 'Heavyweight checkout layer.',
    description: 'A black cotton fleece hoodie for cool mornings and warmer payment flows.',
    basePrice: 42_000_000n,
    maxSupply: 500,
    image: '/products/tempo-hoodie.svg',
    accent: '#111111',
  },
  {
    id: 2,
    name: 'Ceramic Mug',
    sku: 'TMP-MG-02',
    category: 'Home',
    tagline: 'Stablecoin roast holder.',
    description: 'A glazed desk mug with enough capacity for long checkout-debugging sessions.',
    basePrice: 8_000_000n,
    maxSupply: 750,
    image: '/products/ceramic-mug.svg',
    accent: '#355c7d',
  },
  {
    id: 3,
    name: 'Desk Mat',
    sku: 'TMP-DM-03',
    category: 'Workspace',
    tagline: 'A lane for your keyboard.',
    description: 'A wide woven desk mat with a subtle payments-grid pattern.',
    basePrice: 18_000_000n,
    maxSupply: 500,
    image: '/products/desk-mat.svg',
    accent: '#176f5f',
  },
  {
    id: 4,
    name: 'Canvas Tote',
    sku: 'TMP-TT-04',
    category: 'Carry',
    tagline: 'Settlement you can shoulder.',
    description: 'A natural canvas tote sized for a laptop, notebook, and the occasional snack.',
    basePrice: 14_000_000n,
    maxSupply: 800,
    image: '/products/canvas-tote.svg',
    accent: '#7a5c35',
  },
  {
    id: 5,
    name: 'Notebook Pack',
    sku: 'TMP-NB-05',
    category: 'Office',
    tagline: 'For deterministic notes.',
    description: 'Three dot-grid notebooks for writing down orders, memos, and half-formed ideas.',
    basePrice: 12_500_000n,
    maxSupply: 1000,
    image: '/products/notebook-pack.svg',
    accent: '#8a3f2c',
  },
  {
    id: 6,
    name: 'Stainless Bottle',
    sku: 'TMP-BT-06',
    category: 'Drinkware',
    tagline: 'Cold storage, literally.',
    description: 'A double-wall bottle with a slim profile and a tiny Tempo mark.',
    basePrice: 22_000_000n,
    maxSupply: 600,
    image: '/products/stainless-bottle.svg',
    accent: '#4b6572',
  },
  {
    id: 7,
    name: 'Mechanical Keyboard',
    sku: 'TMP-KB-07',
    category: 'Hardware',
    tagline: 'Clicky payment ops.',
    description: 'A compact keyboard with calm gray caps and a dedicated settlement key.',
    basePrice: 64_000_000n,
    maxSupply: 250,
    image: '/products/mechanical-keyboard.svg',
    accent: '#2f4050',
  },
  {
    id: 8,
    name: 'Desk Lamp',
    sku: 'TMP-LP-08',
    category: 'Workspace',
    tagline: 'Finality, illuminated.',
    description: 'An adjustable desk lamp for late-night release checks and careful receipts.',
    basePrice: 35_000_000n,
    maxSupply: 350,
    image: '/products/desk-lamp.svg',
    accent: '#a47726',
  },
  {
    id: 9,
    name: 'Gift Card',
    sku: 'TMP-GC-09',
    category: 'Digital',
    tagline: 'Composable store credit.',
    description: 'A digital merchant credit token for whatever you decide to maybe-pay for next.',
    basePrice: 25_000_000n,
    maxSupply: 1000,
    image: '/products/gift-card.svg',
    accent: '#5d4b8a',
  },
  {
    id: 10,
    name: 'Sticker Sheet',
    sku: 'TMP-ST-10',
    category: 'Accessories',
    tagline: 'Tiny receipts everywhere.',
    description: 'A sheet of matte stickers for laptops, notebooks, and checkout terminals.',
    basePrice: 3_500_000n,
    maxSupply: 2000,
    image: '/products/sticker-sheet.svg',
    accent: '#3d7a43',
  },
] as const satisfies readonly Product[]

export const productsByChain = {
  4217: mainnetProducts,
  42431: testnetProducts,
} as const satisfies Record<ChainId, readonly Product[]>

export const products = testnetProducts

export function getProducts(chainId: string | number | null | undefined): readonly Product[] {
  return productsByChain[normalizeChainId(chainId)]
}

export function getProduct(productId: number, chainId: string | number | null | undefined = 42431): Product | undefined {
  return getProducts(chainId).find((product) => product.id === productId)
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
