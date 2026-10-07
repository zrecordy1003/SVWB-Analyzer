/**
 * The sync Worker: bindings in, `Deps` out. Everything of substance is in the
 * other modules, which know nothing about Cloudflare; this file is the only
 * place that reads `env`.
 *
 * `scheduled` runs the nightly retirement (retire.ts).
 *
 * The Env bindings are typed with this package's own structural interfaces
 * (types.ts), not @cloudflare/workers-types: the real D1Database / R2Bucket
 * satisfy them at runtime, and it keeps this file compilable by the app's root
 * type-check, where the Workers globals would collide with Node's.
 */
import { handle } from './router'
import { retireIdleDevices } from './retire'
import { parseConfig } from './limits'
import type { Deps, Env, JwksCache } from './types'

/**
 * Google's signing keys, cached for the life of the isolate. A cold isolate
 * re-fetches once; the cache is also re-filled when a token names an unknown
 * `kid` (auth.ts), which is how a key rotation is picked up.
 */
const jwks: { current: JwksCache | null } = { current: null }

function depsFor(env: Env): Deps {
  return {
    db: env.DB,
    bucket: env.BUCKET,
    config: parseConfig(env),
    secrets: {
      googleClientId: env.GOOGLE_CLIENT_ID ?? '',
      googleClientSecret: env.GOOGLE_CLIENT_SECRET ?? '',
      sessionSecret: env.SESSION_SECRET ?? ''
    },
    fetch: (url, init) => fetch(url, init),
    now: () => Date.now(),
    jwks,
    ipLimiter: env.IP_LIMITER,
    authIpLimiter: env.AUTH_IP_LIMITER,
    accountLimiter: env.ACCOUNT_LIMITER
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handle(depsFor(env), request)
  },

  async scheduled(_event: unknown, env: Env): Promise<void> {
    const report = await retireIdleDevices(depsFor(env))
    console.log('sync: nightly', JSON.stringify(report))
  }
}
