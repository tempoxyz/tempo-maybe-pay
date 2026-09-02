import { ApiError, apiErrorResponse, requireOperatorAuthorization } from '@/app/lib/api-guard'
import { getServerRailDeployment, getTempoClient } from '@/app/lib/tempo-server'
import { maybePayStoreAbi } from '@tempo-maybe-pay/shared'
import { NextResponse, type NextRequest } from 'next/server'
import { encodeFunctionData, getAddress, isAddress, type Hex } from 'viem'

export const runtime = 'nodejs'

type RouteContext = {
  params: Promise<{ tokenId: string }> | { tokenId: string }
}

function parseTokenId(value: string): bigint {
  if (!/^[0-9]+$/.test(value)) throw new ApiError('Invalid token id')
  const tokenId = BigInt(value)
  if (tokenId === 0n) throw new ApiError('Invalid token id')
  return tokenId
}

function parseOwner(value: unknown): Hex {
  if (typeof value !== 'string' || !isAddress(value)) throw new ApiError('Invalid owner')
  return getAddress(value) as Hex
}

export async function POST(request: NextRequest, context: RouteContext) {
  // `redeemFor` is `onlyProcessor`, so this route is the only way to invoke it and
  // it accepts an arbitrary `owner`. Without a credential any anonymous caller
  // could force a third party's NFT to be surrendered to the store, and pay for
  // it with the operator's gas. No browser code calls this route, so requiring an
  // operator credential does not affect the purchase flow.
  const unauthorized = requireOperatorAuthorization(request)
  if (unauthorized) return unauthorized

  try {
    const { tokenId: tokenIdInput } = await context.params
    const tokenId = parseTokenId(tokenIdInput)
    const body = (await request.json().catch(() => {
      throw new ApiError('Invalid JSON body')
    })) as Record<string, unknown>
    const owner = parseOwner(body.owner)

    const chainId = request.nextUrl.searchParams.get('chainId')
    const railId = request.nextUrl.searchParams.get('rail')
    const deployment = getServerRailDeployment(chainId, railId)
    if (!deployment.store) throw new ApiError('Store is not deployed', 503)

    const data = encodeFunctionData({
      abi: maybePayStoreAbi,
      args: [owner, tokenId],
      functionName: 'redeemFor',
    })
    const client = getTempoClient(deployment.chainId, deployment.railId)
    const receipt = await client.sendTransactionSync({
      calls: [{ data, to: deployment.store }],
      feeToken: deployment.paymentToken,
    } as never)

    return NextResponse.json({
      owner,
      redemptionTransactionHash: receipt.transactionHash as Hex,
      tokenId: tokenId.toString(),
    })
  } catch (error) {
    return apiErrorResponse(error, 'Failed to redeem NFT', 'POST /api/tokens/[tokenId]/redeem')
  }
}
