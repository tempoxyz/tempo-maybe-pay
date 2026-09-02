import { ApiError, apiErrorResponse, clientKeyFor, enforceRateLimit } from '@/app/lib/api-guard'
import {
  deriveEpochSeed,
  ensureEpoch,
  getServerRailDeployment,
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

/**
 * One checkout issues one call to this route, so the allowance only has to cover
 * retries. Every call performs several RPC reads before it will sign anything.
 */
const RATE_LIMIT = 20
const RATE_LIMIT_WINDOW_MS = 60_000

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
  if (typeof value !== 'string' || !isAddress(value)) throw new ApiError('Invalid buyer')
  return getAddress(value) as Hex
}

function parseHex32(value: unknown, label: string): Hex {
  if (typeof value !== 'string' || !isHex(value, { strict: true }) || value.length !== 66) {
    throw new ApiError(`Invalid ${label}`)
  }
  return value as Hex
}

function parsePositiveInteger(value: unknown, label: string): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new ApiError(`Invalid ${label}`)
  return parsed
}

function parseBigIntString(value: unknown, label: string): bigint {
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) throw new ApiError(`Invalid ${label}`)
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
  deployment: ReturnType<typeof getServerRailDeployment>
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
    readEpoch(deployment.chainId, epochId, deployment.railId),
    readNftOwner(deployment.chainId, event.tokenId, deployment.railId),
    readRedemption(deployment.chainId, event.tokenId, deployment.railId),
    readHouseStats(deployment.chainId, deployment.railId),
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
    paymentRailId: deployment.railId,
    paymentTokenSymbol: deployment.symbol,
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
  // Callable without credentials by design: the browser calls it immediately
  // after escrowing payment. Sponsorship is not unconditional — the handler
  // verifies the escrow transfer on-chain and refuses already-processed orders
  // before it signs anything — so the limiter exists to cap the RPC work an
  // anonymous caller can force with deliberately unverifiable orders.
  const limited = enforceRateLimit(`order-process:${clientKeyFor(request)}`, RATE_LIMIT, RATE_LIMIT_WINDOW_MS)
  if (limited) return limited

  try {
    const { orderId } = await context.params
    if (!isHex(orderId, { strict: true }) || orderId.length !== 66) {
      return new NextResponse('Invalid order id', { status: 400 })
    }

    const chainId = request.nextUrl.searchParams.get('chainId')
    const railId = request.nextUrl.searchParams.get('rail')
    const deployment = getServerRailDeployment(chainId, railId)
    if (!deployment.store) throw new ApiError('Store is not deployed', 503)

    if (await readProcessedOrder(deployment.chainId, orderId as Hex, deployment.railId)) {
      return new NextResponse('Order is already processed', { status: 409 })
    }

    const body = (await request.json().catch(() => {
      throw new ApiError('Invalid JSON body')
    })) as Record<string, unknown>
    const buyer = parseBuyer(body.buyer)
    const productId = parsePositiveInteger(body.productId, 'product id')
    const payProbabilityBps = parsePositiveInteger(body.payProbabilityBps, 'payment probability')
    const maxEscrow = parseBigIntString(body.maxEscrow, 'max escrow')
    const paymentTransactionHash = parseHex32(body.paymentTransactionHash, 'payment transaction hash')

    // Escrow verification failures describe the caller's own submitted payment
    // and carry no internal detail, so they are re-raised as caller-visible
    // errors. The shop UI shows this text to the buyer.
    try {
      await verifyEscrowPayment({
        buyer,
        chainId: deployment.chainId,
        maxEscrow,
        orderId: orderId as Hex,
        paymentTransactionHash,
        railId: deployment.railId,
      })
    } catch (error) {
      throw new ApiError(error instanceof Error ? error.message : 'Payment verification failed', 400)
    }

    const epochId = await readCurrentEpochId(deployment.chainId, deployment.railId)
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

    const client = getTempoClient(deployment.chainId, deployment.railId)
    let processTransactionHash: Hex
    try {
      const receipt = await client.sendTransactionSync({
        calls: [{ data, to: deployment.store }],
        feeToken: deployment.paymentToken,
      } as never)
      processTransactionHash = receipt.transactionHash as Hex
    } catch (error) {
      if (!(await readProcessedOrder(deployment.chainId, orderId as Hex, deployment.railId))) throw error
      return new NextResponse('Order is already processed', { status: 409 })
    }

    const processReceipt = (await client.request({
      method: 'eth_getTransactionReceipt',
      params: [processTransactionHash],
    })) as TempoRpcReceipt
    const event = decodeResolvedOrderEvent(processReceipt, deployment.store)

    await ensureEpoch(deployment.chainId, deployment.railId).catch(() => undefined)

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
    return apiErrorResponse(error, 'Failed to process order', 'POST /api/orders/[orderId]/process')
  }
}
