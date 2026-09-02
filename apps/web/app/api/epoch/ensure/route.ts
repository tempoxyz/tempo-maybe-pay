import { apiErrorResponse, clientKeyFor, enforceRateLimit, singleFlight } from '@/app/lib/api-guard'
import { ensureEpoch } from '@/app/lib/tempo-server'
import { NextResponse, type NextRequest } from 'next/server'

export const runtime = 'nodejs'

/**
 * Requests allowed per client per window. `ensureEpoch` is called once per
 * checkout by the browser, so a small allowance covers the legitimate flow while
 * capping how much operator gas an anonymous caller can burn.
 */
const RATE_LIMIT = 10
const RATE_LIMIT_WINDOW_MS = 60_000

export async function POST(request: NextRequest) {
  // Callable without credentials: the browser purchase flow depends on it. The
  // operator-gas exposure is bounded by the limiter below plus `singleFlight`,
  // which stops concurrent callers from each opening their own epoch.
  const limited = enforceRateLimit(`epoch-ensure:${clientKeyFor(request)}`, RATE_LIMIT, RATE_LIMIT_WINDOW_MS)
  if (limited) return limited

  try {
    const chainId = request.nextUrl.searchParams.get('chainId')
    const railId = request.nextUrl.searchParams.get('rail')
    const result = await singleFlight(`epoch-ensure:${chainId ?? 'default'}:${railId ?? 'default'}`, () =>
      ensureEpoch(chainId, railId),
    )
    return NextResponse.json(result)
  } catch (error) {
    return apiErrorResponse(error, 'Failed to ensure epoch', 'POST /api/epoch/ensure')
  }
}
