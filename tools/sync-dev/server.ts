/**
 * The fake Google, on a local port, for trying sync without a Google account.
 *
 * `FakeGoogle` is a `fetch` function; this puts a plain HTTP listener in front of
 * it so the real app (which makes real network requests) can talk to it. Nothing
 * here touches the network or any real account, and the "Drive" lives in memory:
 * restart this and the cloud is empty again (the app notices and starts over).
 *
 *   node tools/sync-dev.mjs
 *   $env:SVWB_GOOGLE_BASE = "http://127.0.0.1:8788"; pnpm dev
 *
 * Not shipped: it lives under tools/ and is only for development and the e2e suite.
 */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import { FakeGoogle } from './fakeGoogle'

const PORT = Number(process.env.SYNC_DEV_PORT ?? 8788)

let google: FakeGoogle

const server = createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const response = await google.fetch(`${origin}${req.url}`, {
      method: req.method,
      headers: req.headers as Record<string, string>,
      body: ['GET', 'HEAD'].includes(req.method ?? 'GET') ? undefined : Buffer.concat(chunks)
    })
    console.log(`${req.method} ${new URL(req.url ?? '/', origin).pathname} -> ${response.status}`)
    res.writeHead(response.status, Object.fromEntries(response.headers))
    res.end(Buffer.from(await response.arrayBuffer()))
  } catch (e) {
    console.error(e)
    res.writeHead(500).end(String(e))
  }
})

server.listen(PORT, '127.0.0.1', () => {
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  google = new FakeGoogle({ origin })
  console.log(`\nfake Google (OAuth + Drive appDataFolder, in memory) on ${origin}\n`)
  console.log(`run the app against it:\n  $env:SVWB_GOOGLE_BASE = "${origin}"; pnpm dev\n`)
})
