#!/usr/bin/env node
/**
 * Manual smoke test against the live Deck Portal.
 *
 * Deliberately NOT part of `pnpm test`: the unit tests are fixture-driven so
 * they stay green offline and in CI, which means nothing in the suite would
 * notice the portal changing under us. This script is the thing that notices.
 *
 *   node tools/svwb-api-smoke.mjs              # read path + hash round trip
 *   node tools/svwb-api-smoke.mjs --code ufj1  # also resolve a live deck code
 *   node tools/svwb-api-smoke.mjs --publish    # also issue a real deck code
 *
 * `--publish` is opt-in because `DeckCode/publish` creates a real (if
 * short-lived, 3 minute) code on Cygames' servers. A script that can be re-run
 * casually should not create things there by default.
 */
const ORIGIN = 'https://shadowverse-wb.com'
const LANG = 'cht'

// A public deck, used only as a fixed input. Any long hash would do.
const HASH =
  '1.7.cQnG.cQnG.cR2I.cR2I.di4E.dzA8.dzA8.eKrc.eKrc.eLN-.eLN-.eLN-.eLae.eLae.eLae.ejG6.ejG6.ejlM.ejlM.ejlM.ej--.ej--.ej--.ej_8.ej_8.ej_8.f5jk.f5jk.f5jk.f69s.f69s.f69s.fUq8.fUq8.fUq8.fslO.fslO.fslO.ftEe.ftEe'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`)
  if (!ok) failures++
}

const headers = (extra = {}) => ({
  Accept: 'application/json, text/plain, */*',
  Lang: LANG,
  'X-Requested-With': 'XMLHttpRequest',
  ...extra
})

async function readDeckByHash() {
  const res = await fetch(
    `${ORIGIN}/web/DeckBuilder/deckHashDetail?hash=${encodeURIComponent(HASH)}`,
    { headers: headers() }
  )
  const body = await res.json()
  check('deckHashDetail responds', body?.data_headers?.result_code === 1)

  const d = body.data
  check('carries a card list', !!d?.deck_card_num && !!d?.sort_card_id_list)

  const total = Object.values(d.deck_card_num).reduce((a, b) => a + b, 0)
  check('deck totals 40 cards', total === 40, `got ${total}`)

  const first = d.card_details?.[d.sort_card_id_list[0]]?.common
  check('card details still nested under .common', !!first)
  // The Lang header is the only way to move off Japanese; if this reverts to
  // kana the header contract changed and every card name in the app is wrong.
  check(
    'Lang header still switches language',
    !!first?.name && !/^[぀-ヿ]+$/.test(first.name),
    first?.name ?? ''
  )
  check(
    'both image hashes present and distinct',
    !!first?.card_image_hash && first.card_image_hash !== first.card_banner_image_hash
  )
  check(
    'deck_enabled_num still supplies the copy limit',
    typeof first?.deck_enabled_num === 'number'
  )

  return d
}

async function checkImagePaths(common) {
  for (const [dir, hash] of [
    ['card', common.card_image_hash],
    ['list', common.card_banner_image_hash]
  ]) {
    const res = await fetch(`${ORIGIN}/uploads/card_image/${LANG}/${dir}/${hash}.png`, {
      method: 'HEAD'
    })
    check(`/${dir}/ image path resolves`, res.status === 200, `HTTP ${res.status}`)
  }
}

/**
 * The encode half of the write path. No side effects - it returns a hash and
 * stores nothing - but it is the piece most likely to break silently, because
 * a wrong payload answers `result_code: 1` with an empty hash rather than an
 * error.
 */
async function checkHashRoundTrip(d) {
  // One GET yields both halves of the credential: `Login/status` issues the
  // `sid` cookie AND returns a CSRF token bound to it. The HTML pages do not
  // reliably set the cookie for a non-browser client, so do not seed from them.
  const probeRes = await fetch(`${ORIGIN}/web/Login/status`, { headers: headers() })
  const cookie = (probeRes.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')
  const csrf = (await probeRes.json())?.data_headers?.csrf_token

  check('session cookie issued by Login/status', !!cookie, cookie ? '' : '(none)')
  check('CSRF token obtainable from the same GET', !!csrf)

  const body = {
    name: '',
    is_published: 1,
    status: 1,
    class_id: d.class_id,
    deck_id: null,
    battle_format: d.battle_format,
    key_card_id: d.sort_card_id_list[0]
  }
  d.sort_card_id_list.forEach((id, i) => {
    body[`card_id${i + 1}`] = Number(id)
    body[`card_num${i + 1}`] = d.deck_card_num[id]
  })

  const res = await fetch(`${ORIGIN}/web/DeckBuilder/getDeckHash`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json', 'X-Csrf-Token': csrf, Cookie: cookie }),
    body: JSON.stringify(body)
  })
  const out = await res.json()
  // An empty string here means the payload shape drifted - the flat
  // card_idN/card_numN pairs are not documented anywhere.
  check(
    'getDeckHash round-trips to the same hash',
    out?.data?.hash === HASH,
    out?.data?.hash ? '' : '(empty hash)'
  )

  // Tokens are single-use and rotate: publish must use the one THIS response
  // returned, not the one Login/status issued.
  return { hash: out?.data?.hash || HASH, cookie, csrf: out?.data_headers?.csrf_token ?? csrf }
}

async function readDeckByCode(code) {
  const res = await fetch(`${ORIGIN}/web/DeckCode/getDeck`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ deck_code: code })
  })
  const body = await res.json()
  const rc = body?.data_headers?.result_code
  if (rc === 10200) {
    console.log(`SKIP  deck code ${code} is invalid or already expired (codes last 3 minutes)`)
    return
  }
  check(`deck code ${code} resolves`, rc === 1)
  const total = Object.values(body.data?.deck_card_num ?? {}).reduce((a, b) => a + b, 0)
  check('code deck totals 40 cards', total === 40, `got ${total}`)
}

/**
 * The last link: hash to 4-character code, and back again.
 *
 * Opt-in only - see the header. Verifying the code resolves is the part worth
 * having: a code that publishes but does not resolve would look like success
 * everywhere except in the game.
 */
async function checkPublish(hash, cookie, csrf) {
  const res = await fetch(`${ORIGIN}/web/DeckCode/publish`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json', 'X-Csrf-Token': csrf, Cookie: cookie }),
    body: JSON.stringify({ hash })
  })
  const out = await res.json()
  const code = out?.data?.deck_code
  check('DeckCode/publish issues a code', typeof code === 'string' && code.length === 4, code ?? '')
  if (code) await readDeckByCode(code)
}

const codeArg = process.argv.indexOf('--code')

const deck = await readDeckByHash()
await checkImagePaths(deck.card_details[deck.sort_card_id_list[0]].common)
const session = await checkHashRoundTrip(deck)
if (process.argv.includes('--publish'))
  await checkPublish(session.hash, session.cookie, session.csrf)
if (codeArg !== -1 && process.argv[codeArg + 1]) await readDeckByCode(process.argv[codeArg + 1])

console.log(
  failures === 0 ? '\nAll portal expectations hold.' : `\n${failures} expectation(s) broke.`
)
process.exit(failures === 0 ? 0 : 1)
