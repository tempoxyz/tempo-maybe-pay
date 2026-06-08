import { getServerDeployment, getTempoClient } from '@/app/lib/tempo-server'
import { maybePayStoreAbi } from '@tempo-maybe-pay/shared'
import { NextResponse, type NextRequest } from 'next/server'
import { encodeFunctionData, getAddress, isAddress, type Hex } from 'viem'

export const runtime = 'nodejs'

type RouteContext = {
  params: Promise<{ tokenId: string }> | { tokenId: string }
}

function parseTokenId(value: string): bigint {
  if (!/^[0-9]+$/.test(value)) throw new Error('Invalid token id')
  const tokenId = BigInt(value)
  if (tokenId === 0n) throw new Error('Invalid token id')
  return tokenId
}

function parseOwner(value: unknown): Hex {
  if (typeof value !== 'string' || !isAddress(value)) throw new Error('Invalid owner')
  return getAddress(value) as Hex
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const { tokenId: tokenIdInput } = await context.params
    const tokenId = parseTokenId(tokenIdInput)
    const body = (await request.json()) as Record<string, unknown>
    const owner = parseOwner(body.owner)

    const chainId = request.nextUrl.searchParams.get('chainId')
    const deployment = getServerDeployment(chainId)
    if (!deployment.store) throw new Error('Store is not deployed')

    const data = encodeFunctionData({
      abi: maybePayStoreAbi,
      args: [owner, tokenId],
      functionName: 'redeemFor',
    })
    const client = getTempoClient(deployment.chainId)
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
    return new NextResponse(error instanceof Error ? error.message : 'Failed to redeem NFT', { status: 500 })
  }
}
