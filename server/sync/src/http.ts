/** Response helpers and the one error type every handler throws. */

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  // Nothing here is cacheable: tokens, per-account listings, quota numbers.
  'cache-control': 'no-store'
}

/**
 * `{ error, message }` with an HTTP status, as docs/sync-protocol.md specifies.
 * The status carries the meaning; `code` is what the client switches on and
 * `message` is for a person reading a log.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {}
  ) {
    super(message)
  }
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } })
}

export function errorResponse(error: ApiError): Response {
  return json({ error: error.code, message: error.message }, error.status, error.headers)
}

export function noContent(): Response {
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })
}

/** Parse a JSON object body, or 422. Never trusts the shape beyond "an object". */
export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  let parsed: unknown
  try {
    parsed = await request.json()
  } catch {
    throw new ApiError(422, 'invalid', 'The body is not valid JSON.')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ApiError(422, 'invalid', 'The body must be a JSON object.')
  }
  return parsed as Record<string, unknown>
}

/**
 * Read a request body up to `max` bytes, abandoning the read the moment it
 * goes over. `request.arrayBuffer()` would happily buffer a hundred megabytes
 * of someone's mistake before any size check could run.
 */
export async function readCapped(
  request: Request,
  max: number,
  tooLarge: () => ApiError
): Promise<Uint8Array> {
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > max) throw tooLarge()
  if (!request.body) return new Uint8Array(0)
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => undefined)
      throw tooLarge()
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}
