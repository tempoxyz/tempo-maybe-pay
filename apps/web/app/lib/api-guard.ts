import { createHash, timingSafeEqual } from 'node:crypto'

/**
 * Shared request guards for the API routes that spend the operator key.
 *
 * Four routes under `app/api` sign transactions with
 * `MAYBEPAY_PROCESSOR_PRIVATE_KEY`. Three of them (`epoch/ensure`,
 * `redemptions/expire-expired`, `orders/[orderId]/process`) are part of the
 * browser purchase flow and must stay callable without credentials; they are
 * protected here by rate limiting, single-flight coalescing and generic error
 * responses. The fourth (`tokens/[tokenId]/redeem`) has no browser caller and
 * forces a redemption for an arbitrary owner, so it requires an operator
 * credential.
 *
 * Guards return the Web `Response` that `NextResponse` extends rather than
 * `NextResponse` itself: route handlers accept either, and staying on the
 * platform type keeps this module importable by the plain Node test runner.
 */

/** Error whose message is safe to return to the caller verbatim. */
export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status = 400) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

/** Minimum accepted length for the operator credential, in characters. */
const MIN_OPERATOR_KEY_LENGTH = 32

/** Header carrying the operator credential, in addition to `Authorization`. */
const OPERATOR_KEY_HEADER = 'x-maybepay-operator-key'

/**
 * Compares two secrets without leaking their contents through timing.
 *
 * Both values are hashed first so `timingSafeEqual` always receives equal-length
 * buffers; comparing raw strings of different lengths throws, and branching on
 * the length difference would itself be an oracle.
 */
function secretsMatch(provided: string, expected: string): boolean {
  const providedDigest = createHash('sha256').update(provided, 'utf8').digest()
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest()
  return timingSafeEqual(providedDigest, expectedDigest)
}

/** Extracts the presented credential from either supported header. */
function readPresentedKey(request: Request): string | null {
  const authorization = request.headers.get('authorization')
  if (authorization) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim())
    if (match?.[1]) return match[1].trim()
  }
  const header = request.headers.get(OPERATOR_KEY_HEADER)
  return header ? header.trim() : null
}

/**
 * Rejects a request that does not present the operator credential.
 *
 * Fails closed in every direction: a missing, short or unset
 * `MAYBEPAY_OPERATOR_API_KEY` yields 503 rather than allowing the request
 * through, so forgetting to configure the secret cannot silently expose the
 * endpoint. The literal `'Bearer undefined'` class of bug is therefore
 * unreachable.
 *
 * @returns `null` when the caller is authorized, otherwise the response to send.
 */
export function requireOperatorAuthorization(request: Request): Response | null {
  const expected = process.env.MAYBEPAY_OPERATOR_API_KEY
  if (!expected || expected.length < MIN_OPERATOR_KEY_LENGTH) {
    console.error(
      `Refusing privileged request: MAYBEPAY_OPERATOR_API_KEY is unset or shorter than ${MIN_OPERATOR_KEY_LENGTH} characters`,
    )
    return new Response('Operator endpoint is not configured', { status: 503 })
  }

  const presented = readPresentedKey(request)
  if (!presented || !secretsMatch(presented, expected)) {
    return new Response('Unauthorized', { status: 401 })
  }

  return null
}

type RateLimitWindow = { count: number; resetAt: number }

/**
 * Fixed-window counters, keyed by route plus client identity.
 *
 * This is a per-instance, in-memory limiter. On a serverless deployment each
 * cold instance starts with an empty map, so it caps the burst a single client
 * can drive through one instance rather than enforcing a global quota. It is a
 * mitigation for operator-gas amplification, not an authorization boundary; a
 * shared store (Redis, Durable Object, Vercel KV) is required for a hard limit.
 */
const rateLimitWindows = new Map<string, RateLimitWindow>()

/** Highest number of tracked windows before the oldest entries are evicted. */
const MAX_TRACKED_WINDOWS = 10_000

/**
 * Derives a rate-limit identity for the caller.
 *
 * Proxy headers are attacker-controlled, so this is a best-effort bucket, not a
 * trusted identifier. The leftmost `x-forwarded-for` hop is used because that is
 * what Vercel's edge appends the real client address as; a caller that forges
 * the header only ever splits its own bucket, which the limiter's purpose
 * tolerates but a security control would not.
 */
export function clientKeyFor(request: Request): string {
  const forwardedFor = request.headers.get('x-forwarded-for')
  const candidate = forwardedFor?.split(',')[0]?.trim() || request.headers.get('x-real-ip')?.trim()
  return candidate && candidate.length > 0 ? candidate : 'unknown'
}

/**
 * Applies a fixed-window rate limit.
 *
 * @param key Bucket identity, typically `${route}:${clientKeyFor(request)}`.
 * @param limit Requests allowed per window.
 * @param windowMs Window length in milliseconds.
 * @returns `null` when the request may proceed, otherwise a 429 response.
 */
export function enforceRateLimit(key: string, limit: number, windowMs: number): Response | null {
  const now = Date.now()
  const existing = rateLimitWindows.get(key)

  if (!existing || existing.resetAt <= now) {
    // Bound memory growth from unique keys before inserting a new window.
    if (rateLimitWindows.size >= MAX_TRACKED_WINDOWS) {
      for (const [trackedKey, window] of rateLimitWindows) {
        if (window.resetAt <= now) rateLimitWindows.delete(trackedKey)
      }
      if (rateLimitWindows.size >= MAX_TRACKED_WINDOWS) {
        const oldest = rateLimitWindows.keys().next()
        if (!oldest.done) rateLimitWindows.delete(oldest.value)
      }
    }
    rateLimitWindows.set(key, { count: 1, resetAt: now + windowMs })
    return null
  }

  if (existing.count >= limit) {
    const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt - now) / 1000))
    return new Response('Too many requests', {
      status: 429,
      headers: { 'Retry-After': String(retryAfterSeconds) },
    })
  }

  existing.count += 1
  return null
}

/** Clears all rate-limit state. Intended for tests. */
export function resetRateLimits(): void {
  rateLimitWindows.clear()
}

/** In-flight operations, keyed by the work they perform. */
const inFlight = new Map<string, Promise<unknown>>()

/**
 * Collapses concurrent identical operations into one execution.
 *
 * `ensureEpoch` reads `currentEpochId`, decides no epoch is open, and only then
 * sends `openEpoch`. Concurrent callers all observe the pre-transaction state
 * and each send their own transaction, so N simultaneous requests burn N epochs
 * of operator gas. Coalescing on a stable key makes the read-decide-send
 * sequence effectively single-threaded per instance.
 *
 * Both success and failure are shared by all joiners, and the entry is always
 * removed afterwards so a failure does not poison later attempts.
 *
 * @param key Identity of the work, e.g. `epoch:4217:default`.
 * @param operation Producer invoked only when no identical call is in flight.
 */
export async function singleFlight<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key)
  if (existing) return existing as Promise<T>

  const pending = (async () => operation())()
  inFlight.set(key, pending)
  try {
    return await pending
  } finally {
    inFlight.delete(key)
  }
}

/**
 * Converts a thrown value into a response without leaking internals.
 *
 * The previous handlers returned `error.message` for every failure, which
 * exposed RPC endpoint URLs, revert payloads, viem stack detail and operator
 * configuration state to anonymous callers. Only `ApiError` messages — raised
 * deliberately for caller-visible conditions such as validation failures — are
 * returned; everything else is logged server-side and answered generically.
 *
 * @param error Value caught by the route handler.
 * @param fallback Message returned for unexpected failures.
 * @param context Label included in the server-side log line.
 */
export function apiErrorResponse(error: unknown, fallback: string, context: string): Response {
  if (error instanceof ApiError) {
    return new Response(error.message, { status: error.status })
  }

  console.error(`${context} failed`, error)
  return new Response(fallback, { status: 500 })
}
