import { getProduct, getProductPrice, normalizeChainId } from '@tempo-maybe-pay/shared'
import { NextResponse, type NextRequest } from 'next/server'

type RouteContext = {
  params: Promise<{ chainId: string; tokenId: string }> | { chainId: string; tokenId: string }
}

export async function GET(request: NextRequest, context: RouteContext) {
  const { chainId, tokenId } = await context.params
  const product = getProduct(Number(tokenId))
  if (!product) return new NextResponse('Not found', { status: 404 })
  const normalizedChainId = normalizeChainId(chainId)
  const basePrice = getProductPrice(product, normalizedChainId)

  return NextResponse.json({
    name: product.name,
    description: product.description,
    image: new URL(product.image, request.url).toString(),
    attributes: [
      { trait_type: 'Tempo chain', value: normalizedChainId.toString() },
      { trait_type: 'SKU', value: product.sku },
      { trait_type: 'Category', value: product.category },
      { trait_type: 'Slack emoji', value: product.slackEmoji },
      { trait_type: 'Base price', value: basePrice.toString() },
      { trait_type: 'Mechanism', value: 'Maybe Pay' },
    ],
  })
}
