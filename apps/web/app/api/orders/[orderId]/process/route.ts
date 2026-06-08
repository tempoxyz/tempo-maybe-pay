import {
  deriveEpochSeed,
  ensureEpoch,
  getServerDeployment,
  getTempoClient,
  readCurrentEpochId,
  readEpoch,
  readHouseStats,
  readNftOwner,
  readProcessedOrder,
  readRedemption,
  verifyEscrowPayment,
} from '@/app/lib/tempo-server'
import { getProduct, getProductPrice, maybePayStoreAbi } from '@tempo-maybe-pay/shared'
import { NextResponse, type NextRequest } from 'next/server'
import { decodeEventLog, encodeFunctionData, getAddress, isAddress, isHex, type Hex, type Log } from 'viem'

export const runtime = 'nodejs'

type RouteContext = {
  params: Promise<{ orderId: string }> | { orderId: string }
}

type TempoRpcReceipt = {
  logs?: readonly Log[]
  transactionHash?: Hex
}

type ResolvedOrderEvent = {
  buyer: Hex
  paidAmount: bigint
  paymentTransactionHash: Hex
  productId: bigint
  redeemDeadline: bigint
  redeemValue: bigint
  refundedAmount: bigint
  roll: bigint
  status: 'paid' | 'free'
  tokenId: bigint
}

function parseBuyer(value: unknown): Hex {
  if (typeof value !== 'string' || !isAddress(value)) throw new Error('Invalid buyer')
  return getAddress(value) as Hex
}

function parseHex32(value: unknown, label: string): Hex {
  if (typeof value !== 'string' || !isHex(value, { strict: true }) || value.length !== 66) {
    throw new Error(`Invalid ${label}`)
  }
  return value as Hex
}

function parsePositiveInteger(value: unknown, label: string): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`Invalid ${label}`)
  return parsed
}

function parseBigIntString(value: unknown, label: string): bigint {
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) throw new Error(`Invalid ${label}`)
  return BigInt(value)
}

function statusFromEvent(value: unknown): 'paid' | 'free' {
  const status = typeof value === 'bigint' ? Number(value) : Number(value)
  if (status === 2) return 'paid'
  if (status === 3) return 'free'
  throw new Error(`Order resolved to unexpected status ${status}`)
}

function decodeResolvedOrderEvent(receipt: TempoRpcReceipt, store: Hex): ResolvedOrderEvent {
  for (const log of receipt.logs ?? []) {
    if (log.address.toLowerCase() !== store.toLowerCase()) continue
    try {
      const decoded = decodeEventLog({
        abi: maybePayStoreAbi,
        data: log.data,
        topics: log.topics,
      })
      if (decoded.eventName !== 'PaymentOrderResolved') continue
      const args = decoded.args
      return {
        buyer: args.buyer,
        paidAmount: args.paidAmount,
        paymentTransactionHash: args.paymentTxHash,
        productId: args.productId,
        redeemDeadline: BigInt(args.redeemDeadline),
        redeemValue: args.redeemValue,
        refundedAmount: args.refundedAmount,
        roll: args.roll,
        status: statusFromEvent(args.status),
        tokenId: args.tokenId,
      }
    } catch {
      continue
    }
  }

  throw new Error('Resolution event was not found')
}

async function buildResolvedResponse({
  deployment,
  epochId,
  event,
  maxEscrow,
  orderId,
  payProbabilityBps,
  processTransactionHash,
}: {
  deployment: ReturnType<typeof getServerDeployment>
  epochId: bigint
  event: ResolvedOrderEvent
  maxEscrow: bigint
  orderId: Hex
  payProbabilityBps: number
  processTransactionHash: Hex
}) {
  const product = getProduct(Number(event.productId))
  if (!product) throw new Error('Unknown product')

  const [epoch, nftOwner, redemption, houseStats] = await Promise.all([
    readEpoch(deployment.chainId, epochId),
    readNftOwner(deployment.chainId, event.tokenId),
    readRedemption(deployment.chainId, event.tokenId),
    readHouseStats(deployment.chainId),
  ])
  const seed = deriveEpochSeed(deployment, epochId)
  const basePrice = getProductPrice(product, deployment.chainId)

  return NextResponse.json({
    basePrice: basePrice.toString(),
    buyer: event.buyer,
    commitment: epoch.commitment,
    epochId: epochId.toString(),
    maxEscrow: maxEscrow.toString(),
    houseAvailableReserve: houseStats.availableReserve.toString(),
    houseBankroll: houseStats.bankroll.toString(),
    houseOutstandingLiability: houseStats.outstandingLiability.toString(),
    housePendingEscrow: houseStats.pendingEscrow.toString(),
    merchant: deployment.merchant,
    metadataHash: event.paymentTransactionHash,
    nftOwner,
    orderId,
    paidAmount: event.paidAmount.toString(),
    payProbabilityBps,
    paymentTransactionHash: event.paymentTransactionHash,
    processTransactionHash,
    productId: event.productId.toString(),
    refundedAmount: event.refundedAmount.toString(),
    redeemActive: redemption.active,
    redeemDeadline: redemption.deadline.toString(),
    redeemValue: redemption.value.toString(),
    roll: event.roll.toString(),
    seed,
    status: event.status,
    threshold: payProbabilityBps.toString(),
    tokenId: event.tokenId.toString(),
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

    if (await readProcessedOrder(deployment.chainId, orderId as Hex)) {
      return new NextResponse('Order is already processed', { status: 409 })
    }

    const body = (await request.json()) as Record<string, unknown>
    const buyer = parseBuyer(body.buyer)
    const productId = parsePositiveInteger(body.productId, 'product id')
    const payProbabilityBps = parsePositiveInteger(body.payProbabilityBps, 'payment probability')
    const maxEscrow = parseBigIntString(body.maxEscrow, 'max escrow')
    const paymentTransactionHash = parseHex32(body.paymentTransactionHash, 'payment transaction hash')

    await verifyEscrowPayment({
      buyer,
      chainId: deployment.chainId,
      maxEscrow,
      orderId: orderId as Hex,
      paymentTransactionHash,
    })

    const epochId = await readCurrentEpochId(deployment.chainId)
    const seed = deriveEpochSeed(deployment, epochId)
    const data = encodeFunctionData({
      abi: maybePayStoreAbi,
      args: [
        orderId as Hex,
        buyer,
        BigInt(productId),
        payProbabilityBps,
        maxEscrow,
        paymentTransactionHash,
        seed,
      ],
      functionName: 'processPaidOrder',
    })

    const client = getTempoClient(deployment.chainId)
    let processTransactionHash: Hex
    try {
      const receipt = await client.sendTransactionSync({
        calls: [{ data, to: deployment.store }],
        feeToken: deployment.paymentToken,
      } as never)
      processTransactionHash = receipt.transactionHash as Hex
    } catch (error) {
      if (!(await readProcessedOrder(deployment.chainId, orderId as Hex))) throw error
      return new NextResponse('Order is already processed', { status: 409 })
    }

    const processReceipt = (await client.request({
      method: 'eth_getTransactionReceipt',
      params: [processTransactionHash],
    })) as TempoRpcReceipt
    const event = decodeResolvedOrderEvent(processReceipt, deployment.store)

    await ensureEpoch(deployment.chainId).catch(() => undefined)

    return buildResolvedResponse({
      deployment,
      epochId,
      event,
      maxEscrow,
      orderId: orderId as Hex,
      payProbabilityBps,
      processTransactionHash,
    })
  } catch (error) {
    return new NextResponse(error instanceof Error ? error.message : 'Failed to process order', { status: 500 })
  }
}
