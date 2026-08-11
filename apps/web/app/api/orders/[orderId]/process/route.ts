import {
  ensureEpoch,
  getServerRailDeployment,
  getTempoClient,
  readCurrentEpochId,
  readEpoch,
  readHouseStats,
  readNftOwner,
  readProcessedOrder,
  readRedemption,
  revealEpochSeed,
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

// [SECURITY PATCH]: Custom error class to differentiate client validation errors from internal server errors
class ValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

function parseBuyer(value: unknown): Hex {
  if (typeof value !== 'string' || !isAddress(value)) throw new ValidationError('Invalid buyer')
  return getAddress(value) as Hex
}

function parseHex32(value: unknown, label: string): Hex {
  if (typeof value !== 'string' || !isHex(value, { strict: true }) || value.length !== 66) {
    throw new ValidationError(`Invalid ${label}`)
  }
  return value as Hex
}

function parsePositiveInteger(value: unknown, label: string): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new ValidationError(`Invalid ${label}`)
  return parsed
}

function parseBigIntString(value: unknown, label: string): bigint {
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) throw new ValidationError(`Invalid ${label}`)
  return BigInt(value)
}

// [TYPE SAFETY PATCH]: Removed the dead identical-branch ternary (typeof value === 'bigint' ? Number(v) : Number(v))
function statusFromEvent(value: unknown): 'paid' | 'free' {
  const status = Number(value)
  if (status === 2) return 'paid'
  if (status === 3) return 'free'
  throw new Error(`Order resolved to unexpected status ${status}`)
}

// [TYPE SAFETY PATCH]: Replaces the unsafe 'as never' casting in sendTransactionSync
type StoreCall = { to: Hex; data: Hex; feeToken: Hex }
const sendStoreTx = async (client: ReturnType<typeof getTempoClient>, call: StoreCall) => {
  // We use type assertion locally in a controlled wrapper rather than globally propagating 'as never'
  return client.sendTransactionSync({
    calls: [{ to: call.to, data: call.data }],
    feeToken: call.feeToken,
  } as any)
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
  
  // [SECURITY PATCH]: Replaced deterministic derivation with a secure lookup of the CSPRNG seed via commitment
  const seed = await revealEpochSeed(undefined, epoch.commitment)
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
  try {
    const { orderId } = await context.params
    if (!isHex(orderId, { strict: true }) || orderId.length !== 66) {
      return new NextResponse('Invalid order id', { status: 400 })
    }

    const chainId = request.nextUrl.searchParams.get('chainId')
    const railId = request.nextUrl.searchParams.get('rail')
    const deployment = getServerRailDeployment(chainId, railId)
    if (!deployment.store) throw new Error('Store is not deployed')

    if (await readProcessedOrder(deployment.chainId, orderId as Hex, deployment.railId)) {
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
      railId: deployment.railId,
    })

    const epochId = await readCurrentEpochId(deployment.chainId, deployment.railId)
    const epoch = await readEpoch(deployment.chainId, epochId, deployment.railId)
    
    // [SECURITY PATCH]: Replaced deterministic derivation with a secure lookup of the CSPRNG seed via commitment
    const seed = await revealEpochSeed(undefined, epoch.commitment)
    
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
      // [TYPE SAFETY PATCH]: Use the controlled sendStoreTx wrapper instead of casting the entire payload object 'as never'
      const receipt = await sendStoreTx(client, {
        to: deployment.store,
        data,
        feeToken: deployment.paymentToken,
      })
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

    // [SECURITY PATCH]: ensureEpoch execution failures are now logged server-side rather than silently swallowed
    await ensureEpoch(deployment.chainId, deployment.railId).catch((e) => 
      console.error('[maybepay] ensureEpoch failed', e)
    )

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
    // [SECURITY PATCH]: Prevent information leakage (e.g., RPC node responses or private key config diagnostics)
    // Detailed errors stay in the server log. The client only sees a generic 400 or 500 status.
    console.error('[maybepay] process failed', error)
    const status = error instanceof ValidationError ? 400 : 500
    return new NextResponse(status === 400 ? 'Invalid request' : 'Failed to process order', { status })
  }
}