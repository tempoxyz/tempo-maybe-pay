import { getProduct } from '@tempo-maybe-pay/shared'
import { notFound } from 'next/navigation'
import { Suspense } from 'react'
import { Shop } from '../../components/shop'

type CheckoutPageProps = {
  params: Promise<{
    productId: string
  }>
}

export default async function CheckoutPage({ params }: CheckoutPageProps) {
  const { productId } = await params
  const parsedProductId = Number(productId)

  if (!Number.isInteger(parsedProductId) || !getProduct(parsedProductId)) {
    notFound()
  }

  return (
    <Suspense fallback={<main className="shell">Loading Tempo Store...</main>}>
      <Shop checkoutProductId={parsedProductId} />
    </Suspense>
  )
}
