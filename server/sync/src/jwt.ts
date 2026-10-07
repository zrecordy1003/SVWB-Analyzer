/**
 * The small crypto toolbox: base64url, SHA-256, HMAC, and the HS256 JWT the
 * Worker issues as an access token. WebCrypto only - no library, no Node API -
 * so the same file runs in the Worker and under the tests.
 *
 * The access token is a JWT rather than an opaque id because verifying it needs
 * no D1 read. (The request path still reads the device row, to honour revoke;
 * but the signature check rejects garbage before that costs anything.)
 */

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function utf8(text: string): Uint8Array {
  return encoder.encode(text)
}

export function b64urlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Strict: anything outside the base64url alphabet is null, not "best effort". */
export function b64urlDecode(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null
  const padded =
    text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4)
  try {
    const binary = atob(padded)
    const out = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

export function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource))
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  return hex(await sha256(typeof data === 'string' ? utf8(data) : data))
}

/** `n` random bytes, base64url. The only source of tokens in this Worker. */
export function randomToken(n = 32): string {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(n)))
}

/**
 * Compare two strings without an early exit. For secrets and hashes only; the
 * length is allowed to leak (both sides are fixed-length by construction).
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const x = utf8(a)
  const y = utf8(b)
  let diff = x.length ^ y.length
  const len = Math.max(x.length, y.length)
  for (let i = 0; i < len; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}

async function hmacKey(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    utf8(secret) as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage]
  )
}

export async function hmacSign(secret: string, message: string): Promise<string> {
  const key = await hmacKey(secret, 'sign')
  return b64urlEncode(
    new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8(message) as BufferSource))
  )
}

/** Constant-time by construction: `subtle.verify` does the comparison. */
export async function hmacVerify(
  secret: string,
  message: string,
  signature: string
): Promise<boolean> {
  const sig = b64urlDecode(signature)
  if (!sig) return false
  const key = await hmacKey(secret, 'verify')
  return crypto.subtle.verify('HMAC', key, sig as BufferSource, utf8(message) as BufferSource)
}

// ---------------------------------------------------------------- HS256 JWT

export interface AccessClaims {
  sub: string
  did: string
  /** Seconds since the epoch, as RFC 7519 has it. */
  exp: number
  iat: number
}

const JWT_HEADER = b64urlEncode(utf8(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))

export async function signAccessToken(secret: string, claims: AccessClaims): Promise<string> {
  const body = `${JWT_HEADER}.${b64urlEncode(utf8(JSON.stringify(claims)))}`
  return `${body}.${await hmacSign(secret, body)}`
}

export type VerifyResult =
  | { ok: true; claims: AccessClaims }
  | { ok: false; reason: 'malformed' | 'signature' | 'expired' }

/**
 * Check the signature FIRST and the expiry second, so an expired token is only
 * ever reported as `expired` when it was genuinely ours - a forged one never
 * learns anything. The header must be exactly HS256: accepting whatever `alg`
 * the token names is the classic way a JWT check turns into no check at all.
 */
export async function verifyAccessToken(
  secret: string,
  token: string,
  nowMs: number
): Promise<VerifyResult> {
  const parts = token.split('.')
  if (parts.length !== 3) return { ok: false, reason: 'malformed' }
  const [header, payload, signature] = parts
  if (header !== JWT_HEADER) return { ok: false, reason: 'malformed' }
  if (!(await hmacVerify(secret, `${header}.${payload}`, signature))) {
    return { ok: false, reason: 'signature' }
  }
  const raw = b64urlDecode(payload)
  if (!raw) return { ok: false, reason: 'malformed' }
  let claims: unknown
  try {
    claims = JSON.parse(decoder.decode(raw))
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  const c = claims as Partial<AccessClaims> | null
  if (
    !c ||
    typeof c.sub !== 'string' ||
    typeof c.did !== 'string' ||
    typeof c.exp !== 'number' ||
    !Number.isFinite(c.exp)
  ) {
    return { ok: false, reason: 'malformed' }
  }
  if (c.exp * 1000 <= nowMs) return { ok: false, reason: 'expired' }
  return { ok: true, claims: c as AccessClaims }
}

/** Decode a JWT's JSON segment WITHOUT trusting it; callers verify first. */
export function decodeJwtSegment(segment: string): Record<string, unknown> | null {
  const raw = b64urlDecode(segment)
  if (!raw) return null
  try {
    const value: unknown = JSON.parse(decoder.decode(raw))
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}
