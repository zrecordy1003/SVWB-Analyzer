/**
 * A local stand-in for the whole sync backend, for trying the app without
 * Google or Cloudflare accounts.
 *
 * It is the REAL Worker router (`server/sync/src`) behind plain Node HTTP,
 * with SQLite-in-memory for D1, a Map for R2, and a fake Google whose consent
 * page just asks "which account?". Nothing here touches the network or any
 * real account. State is in memory: restart it and the cloud is empty again
 * (the app notices and starts over - see `cloudLostThisDevice`).
 *
 *   node tools/sync-dev.mjs            # prints the SVWB_SYNC_URL to run the app with
 *
 * Not for production and not shipped: it lives under tools/ and imports the
 * test doubles.
 */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash } from 'node:crypto'

import { handle } from '../../server/sync/src/router'
import { world } from '../../tests/server/sync/helpers'

const PORT = Number(process.env.SYNC_DEV_PORT ?? 8788)

const w = await world()
let origin = ''

// The fake Google insists on the redirect URI the unit tests use; the Worker
// builds the real one from the request origin, so translate on the way out.
const googleFetch = w.deps.fetch
w.deps.fetch = ((url, init) => {
  if (typeof init?.body === 'string' && String(url).includes('/token')) {
    const form = new URLSearchParams(init.body)
    if (form.get('redirect_uri') === `${origin}/auth/callback`) {
      form.set('redirect_uri', 'https://sync.test/auth/callback')
      return googleFetch(url, { ...init, body: form.toString() })
    }
  }
  return googleFetch(url, init)
}) as typeof w.deps.fetch

const page = (body: string): string =>
  `<!doctype html><meta charset="utf-8"><title>Fake Google</title>` +
  `<body style="font-family:system-ui;max-width:30em;margin:4em auto;padding:0 1em">${body}</body>`

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)

async function consent(url: URL): Promise<Response> {
  const q = url.searchParams
  const fields = ['state', 'nonce']
    .map((k) => `<input type="hidden" name="${k}" value="${esc(q.get(k) ?? '')}">`)
    .join('')
  return new Response(
    page(
      `<h2>Sign in with Google <small style="color:#b00">(local fake)</small></h2>` +
        `<p>This is the development stand-in. Pick any address; the same address is the same account.</p>` +
        `<form method="get" action="/dev/google/approve">${fields}` +
        `<input name="email" value="me@example.com" style="width:100%;padding:.5em;font-size:1em">` +
        `<p><button style="padding:.5em 1.2em;font-size:1em">Continue</button></p></form>`
    ),
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  )
}

async function approve(url: URL): Promise<Response> {
  const email = (url.searchParams.get('email') ?? 'me@example.com').trim().toLowerCase()
  // A stable subject per address, like Google's: the account key is `sub`, not the email.
  const sub = String(BigInt('0x' + createHash('sha256').update(email).digest('hex').slice(0, 15)))
  w.clock.t = Date.now()
  const code = await w.google.issueCode({
    sub,
    email,
    name: email.split('@')[0],
    nonce: url.searchParams.get('nonce') ?? ''
  })
  const back = new URL('/auth/callback', origin)
  back.searchParams.set('code', code)
  back.searchParams.set('state', url.searchParams.get('state') ?? '')
  return Response.redirect(back.toString(), 302)
}

const server = createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const url = new URL(req.url ?? '/', origin)
    w.clock.t = Date.now()

    let response: Response
    if (url.pathname === '/dev/google') response = await consent(url)
    else if (url.pathname === '/dev/google/approve') response = await approve(url)
    else {
      response = await handle(
        w.deps,
        new Request(`${origin}${req.url}`, {
          method: req.method,
          headers: req.headers as Record<string, string>,
          body: ['GET', 'HEAD'].includes(req.method ?? 'GET') ? undefined : Buffer.concat(chunks)
        })
      )
      // The Worker redirects the browser to the real Google; here it goes to the fake one.
      const location = response.headers.get('location')
      if (response.status === 302 && location?.startsWith('https://accounts.google.com/')) {
        const to = new URL('/dev/google', origin)
        to.search = new URL(location).search
        response = Response.redirect(to.toString(), 302)
      }
    }
    console.log(`${req.method} ${url.pathname} -> ${response.status}`)
    res.writeHead(response.status, Object.fromEntries(response.headers))
    res.end(Buffer.from(await response.arrayBuffer()))
  } catch (e) {
    console.error(e)
    res.writeHead(500).end(String(e))
  }
})

server.listen(PORT, '127.0.0.1', () => {
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  console.log(`\nsync dev server (fake Google, in-memory) on ${origin}\n`)
  console.log(`run the app against it:\n  $env:SVWB_SYNC_URL = "${origin}"; pnpm dev\n`)
})
