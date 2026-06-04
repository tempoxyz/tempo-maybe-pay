import {
  deriveEpochSeed,
  ensureEpoch,
  getServerDeployment,
  getTempoClient,
  orderStatusName,
  readEpoch,
  readNftOwner,
  readOrder,
} from '@/app/lib/tempo-server'
import { maybePayStoreAbi } from '@tempo-maybe-pay/shared'
import { NextResponse, type NextRequest } from 'next/server'
import { encodeFunctionData, isHex, type Hex } from 'viem'

export const runtime = 'nodejs'

type RouteContext = {
  params: Promise<{ orderId: string }> | { orderId: string }
}

type ReadOrderResult = Awaited<ReturnType<typeof readOrder>>

async function buildResolvedResponse(
  deployment: ReturnType<typeof getServerDeployment>,
  orderId: Hex,
  order: ReadOrderResult,
  processTransactionHash?: Hex,
) {
  const status = orderStatusName(order.status)
  if (status !== 'paid' && status !== 'free') {
    return new NextResponse(`Order resolved to unexpected status ${status}`, { status: 500 })
  }

  const [epoch, nftOwner] = await Promise.all([
    readEpoch(deployment.chainId, order.epochId),
    readNftOwner(deployment.chainId, order.tokenId),
  ])
  const seed = deriveEpochSeed(deployment, order.epochId)
  const paidAmount = status === 'paid' ? order.maxEscrow : 0n
  const refundedAmount = status === 'free' ? order.maxEscrow : 0n

  return NextResponse.json({
    basePrice: order.basePrice.toString(),
    buyer: order.buyer,
    commitment: epoch.commitment,
    epochId: order.epochId.toString(),
    maxEscrow: order.maxEscrow.toString(),
    merchant: deployment.merchant,
    metadataHash: order.metadataHash,
    nftOwner,
    orderId,
    paidAmount: paidAmount.toString(),
    payProbabilityBps: order.payProbabilityBps,
    processTransactionHash,
    productId: order.productId.toString(),
    refundedAmount: refundedAmount.toString(),
    roll: order.roll.toString(),
    seed,
    status,
    threshold: order.payProbabilityBps.toString(),
    tokenId: order.tokenId.toString(),
  })
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const { orderId } = await context.params
    if (!isHex(orderId, { strict: true }) || orderId.length !== 66) {
      return new NextResponse('Invalid order id', { status: 400 })
    }

    const chainId = request.nextUrl.searchParams.get('chainId')
    const deployment = getServerDeployment(chainId)
    if (!deployment.store) throw new Error('Store is not deployed')

    const before = await readOrder(deployment.chainId, orderId as Hex)
    const beforeStatus = orderStatusName(before.status)
    if (beforeStatus === 'none') return new NextResponse('Order not found', { status: 404 })
    if (beforeStatus === 'paid' || beforeStatus === 'free') {
      return buildResolvedResponse(deployment, orderId as Hex, before)
    }
    if (beforeStatus !== 'pending') {
      return new NextResponse(`Order is ${beforeStatus}`, { status: 409 })
    }

    const seed = deriveEpochSeed(deployment, before.epochId)
    const data = encodeFunctionData({
      abi: maybePayStoreAbi,
      args: [orderId as Hex, seed],
      functionName: 'processOrder',
    })

    const client = getTempoClient(deployment.chainId)
    let processTransactionHash: Hex | undefined
    try {
      const receipt = await client.sendTransactionSync({
        calls: [{ data, to: deployment.store }],
        feeToken: deployment.paymentToken,
      } as never)
      processTransactionHash = receipt.transactionHash as Hex
    } catch (error) {
      const reread = await readOrder(deployment.chainId, orderId as Hex)
      const status = orderStatusName(reread.status)
      if (status !== 'paid' && status !== 'free') throw error
    }

    const after = await readOrder(deployment.chainId, orderId as Hex)

    await ensureEpoch(deployment.chainId).catch(() => undefined)

    return buildResolvedResponse(deployment, orderId as Hex, after, processTransactionHash)
  } catch (error) {
    return new NextResponse(error instanceof Error ? error.message : 'Failed to process order', { status: 500 })
  }
}
