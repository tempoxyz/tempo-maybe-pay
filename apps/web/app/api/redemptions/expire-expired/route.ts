import { expireExpiredRedemptions } from '@/app/lib/tempo-server'
import { NextResponse, type NextRequest } from 'next/server'

export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
  try {
    const chainId = request.nextUrl.searchParams.get('chainId')
    const railId = request.nextUrl.searchParams.get('rail')
    const result = await expireExpiredRedemptions(chainId, railId)
    return NextResponse.json(result)
  } catch (error) {
    return new NextResponse(error instanceof Error ? error.message : 'Failed to expire redemptions', { status: 500 })
  }
}
