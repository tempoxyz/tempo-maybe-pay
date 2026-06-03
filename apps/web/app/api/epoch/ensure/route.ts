import { ensureEpoch } from '@/app/lib/tempo-server'
import { NextResponse, type NextRequest } from 'next/server'

export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
  try {
    const chainId = request.nextUrl.searchParams.get('chainId')
    const result = await ensureEpoch(chainId)
    return NextResponse.json(result)
  } catch (error) {
    return new NextResponse(error instanceof Error ? error.message : 'Failed to ensure epoch', { status: 500 })
  }
}

