import { apiErrorResponse, clientKeyFor, enforceRateLimit, singleFlight } from '@/app/lib/api-guard'
import { expireExpiredRedemptions } from '@/app/lib/tempo-server'
import { NextResponse, type NextRequest } from 'next/server'

export const runtime = 'nodejs'

/**
 * This route drives a bounded sequential scan of redemption slots plus, when
 * anything expired, one operator-signed transaction. The scan is the expensive
 * part, so the window is tighter than the epoch route's.
 */
const RATE_LIMIT = 5
const RATE_LIMIT_WINDOW_MS = 60_000

export async function POST(request: NextRequest) {
  // Callable without credentials: the shop UI invokes it to release house
  // bankroll locked by expired claims. `expireRedemptions` is permissionless
  // on-chain, so the exposure is operator gas and RPC load, both capped here.
  const limited = enforceRateLimit(
    `expire-expired:${clientKeyFor(request)}`,
    RATE_LIMIT,
    RATE_LIMIT_WINDOW_MS,
  )
  if (limited) return limited

  try {
    const chainId = request.nextUrl.searchParams.get('chainId')
    const railId = request.nextUrl.searchParams.get('rail')
    // One scan at a time per deployment: concurrent scans would multiply the RPC
    // fan-out and could each submit an overlapping expiry transaction.
    const result = await singleFlight(`expire-expired:${chainId ?? 'default'}:${railId ?? 'default'}`, () =>
      expireExpiredRedemptions(chainId, railId),
    )
    return NextResponse.json(result)
  } catch (error) {
    return apiErrorResponse(error, 'Failed to expire redemptions', 'POST /api/redemptions/expire-expired')
  }
}
