/**
 * Deck import: parsing what the user pasted, and reading what the portal
 * answered.
 *
 * Everything here is pure. The network lives in `src/main/data/svwbApi.ts`;
 * this file is what both sides agree the data means, and what the tests can
 * exercise without a socket. See docs/deck-import-plan.md.
 *
 * Two of the lookup tables below were derived by cross-checking real responses,
 * not read from documentation - `CLASS_ID_TO_NAME` and the card-type mapping.
 * They are the most likely thing here to break silently when the portal
 * changes, which is why they are pinned by tests rather than inlined at their
 * call sites.
 */
import { ClassName } from './domain.js'

/* ================================
 * Portal vocabulary
 * ================================ */

/**
 * The portal's `class_id`.
 *
 * These names match `classMap.ts`'s ids exactly, but the ORDER is different -
 * that file lists bishop fifth and nightmare sixth, the portal the other way
 * round. Anything that maps by array index silently swaps the two classes,
 * which is why this is an explicit table.
 */
export const CLASS_ID_TO_NAME: Readonly<Record<number, ClassName>> = {
  1: ClassName.elf,
  2: ClassName.royal,
  3: ClassName.witch,
  4: ClassName.dragon,
  5: ClassName.nightmare,
  6: ClassName.bishop,
  7: ClassName.nemesis
}

export const CLASS_NAME_TO_ID: Readonly<Record<ClassName, number>> = Object.freeze(
  Object.fromEntries(
    Object.entries(CLASS_ID_TO_NAME).map(([id, name]) => [name, Number(id)])
  ) as Record<ClassName, number>
)

/** 1 rotation, 2 unlimited, 3 infinity, 4 starter, as the portal numbers them. */
export const BattleFormat = {
  rotation: 1,
  unlimited: 2,
  infinity: 3,
  starter: 4
} as const
export type BattleFormat = (typeof BattleFormat)[keyof typeof BattleFormat]

export type CardKind = 'follower' | 'spell' | 'amulet'

/**
 * `common.type` to the three kinds the portal counts.
 *
 * Reverse-engineered: the counts this produces were checked against the
 * `num_follower` / `num_spell` / `num_amulet` totals of two different decks.
 * Types 2 and 3 are BOTH amulets - the portal rolls them into a single
 * `num_amulet`, and the split is most likely permanent versus countdown. An
 * unknown type returns null rather than guessing into one of the buckets.
 */
export function cardKindFromType(type: number | null | undefined): CardKind | null {
  switch (type) {
    case 1:
      return 'follower'
    case 4:
      return 'spell'
    case 2:
    case 3:
      return 'amulet'
    default:
      return null
  }
}

/* ================================
 * Parsing what the user pasted
 * ================================ */

export type DeckInputKind = 'code' | 'hash'

export interface ParsedDeckInput {
  kind: DeckInputKind
  value: string
}

const PORTAL_HOSTS = new Set(['shadowverse-wb.com', 'www.shadowverse-wb.com'])

/**
 * Fold the things a paste picks up: surrounding whitespace, zero-width
 * characters, and full-width latin digits and letters.
 *
 * The full-width case is not hypothetical - a deck code copied while a Japanese
 * or Chinese IME is active arrives as `ｕｆｊ１`, which is four characters that
 * look exactly right and match nothing.
 */
export function normalizeDeckInput(raw: string): string {
  return (raw ?? '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ')
    .trim()
}

const DECK_CODE_RE = /^[A-Za-z0-9]{4}$/
/** `1.7.cQnG.cQnG....` - version, class, then one token per card. */
const DECK_HASH_RE = /^\d+\.\d+(?:\.[A-Za-z0-9_-]+){2,}$/

/**
 * Work out whether the user gave us a share link, a long hash, or a
 * 4-character deck code. Returns null when it is none of them.
 */
export function parseDeckInput(raw: string): ParsedDeckInput | null {
  const text = normalizeDeckInput(raw)
  if (!text) return null

  if (/^https?:\/\//i.test(text)) {
    let url: URL
    try {
      url = new URL(text)
    } catch {
      return null
    }
    if (!PORTAL_HOSTS.has(url.hostname.toLowerCase())) return null
    const hash = normalizeDeckInput(url.searchParams.get('hash') ?? '')
    if (DECK_HASH_RE.test(hash)) return { kind: 'hash', value: hash }
    const code = normalizeDeckInput(url.searchParams.get('deck_code') ?? '')
    if (DECK_CODE_RE.test(code)) return { kind: 'code', value: code }
    return null
  }

  if (DECK_HASH_RE.test(text)) return { kind: 'hash', value: text }
  if (DECK_CODE_RE.test(text)) return { kind: 'code', value: text }
  return null
}

/**
 * The in-app URL for a card picture.
 *
 * `list` is the banner crop (~130KB) and takes `bannerHash`; `card` is the full
 * art (~470KB) and takes `imageHash`. They are not interchangeable - the portal
 * answers 403 if the wrong hash is used with a path.
 *
 * The scheme is served by the main process (see `cardImageProtocol.ts`), which
 * is what keeps the portal's real URL, the download, the disk cache and the
 * feature's off switch out of the renderer entirely.
 */
export function cardImageUrl(variant: 'card' | 'list', hash: string | null): string | null {
  return hash ? `svwb-card://${variant}/${hash}` : null
}

/** The share link for a long hash. Codes expire; this does not. */
export function shareUrlForHash(hash: string, lang = 'cht'): string {
  return `https://shadowverse-wb.com/${lang}/deck/detail/?hash=${encodeURIComponent(hash)}`
}

/* ================================
 * The shape the app consumes
 * ================================ */

/**
 * One card, as the portal describes it.
 *
 * Shared by the deck endpoints and the card pool endpoint, which return the
 * same `card_details[id].common` object - so `readCardMaster` reads it once and
 * both callers add only what is theirs (a copy count, or a pool position).
 */
export interface CardMaster {
  cardId: number
  name: string
  cost: number | null
  type: number | null
  kind: CardKind | null
  /**
   * The CARD's own class, which is not the deck's.
   *
   * A nemesis deck contains neutral cards, and those come back with
   * `common.class` of 0. Storing the deck's class against every card in it
   * would file the neutrals under a class they do not belong to, and the card
   * pool reads by class.
   */
  cardClass: number | null
  rarity: number | null
  atk: number | null
  life: number | null
  skillText: string | null
  tribes: number[]
  /** The portal's own per-card copy limit; an editor should use this, not a rule of its own. */
  deckEnabledNum: number | null
  /** Pairs with the /card/ image path. */
  imageHash: string | null
  /** Pairs with the /list/ image path. NOT interchangeable with `imageHash`. */
  bannerHash: string | null
  isToken: boolean
}

/** A card in a deck: everything the portal knows, plus how many copies. */
export interface DeckImportCard extends CardMaster {
  count: number
}

/** A card in a format's pool, in the portal's own display order. */
export interface PoolCard extends CardMaster {
  sortIndex: number
}

/**
 * A deck's card as it comes back out of the database.
 *
 * Narrower than `DeckImportCard`: `Card` is a cache of the portal's data and a
 * row may be missing or stale, so anything not needed to render the list is not
 * promised here. A missing cache row degrades to `#<cardId>` with null details
 * rather than failing the read.
 */
export interface StoredDeckCard {
  cardId: number
  count: number
  name: string
  cost: number | null
  type: number | null
  kind: CardKind | null
  rarity: number | null
  atk: number | null
  life: number | null
  skillText: string | null
  imageHash: string | null
  bannerHash: string | null
  isToken: boolean
}

export interface DeckImportPreview {
  source: ParsedDeckInput
  /** The long hash, when we have one. Null for a code import - codes are not hashes. */
  hash: string | null
  classId: number | null
  className: ClassName | null
  battleFormat: number | null
  keyCardId: number | null
  cards: DeckImportCard[]
  totalCards: number
  /** Exact cost buckets, computed here. Unlike the portal's, 8+ is not collapsed. */
  manaCurve: Record<number, number>
  counts: { follower: number; spell: number; amulet: number }
  fingerprint: string
  /**
   * True when the response was readable enough to show something but not
   * everything - a card list with details missing, say. The UI must let the
   * user continue; a partial import is better than none, because a deck code
   * cannot be fetched twice.
   */
  partial: boolean
  /** The response as received, verbatim, for `Deck.rawJson`. */
  raw: string
}

/* ================================
 * Fingerprint
 * ================================ */

/**
 * A stable key for "this is the same 40 cards".
 *
 * Deliberately a readable joined string rather than a digest: it needs no
 * crypto (so it is identical in main and renderer), and when duplicate
 * detection misfires the column says why at a glance. Sorted numerically so
 * card order in the response cannot change the result.
 */
export function fingerprintDeck(cards: ReadonlyArray<{ cardId: number; count: number }>): string {
  return [...cards]
    .filter((c) => c.count > 0)
    .sort((a, b) => a.cardId - b.cardId)
    .map((c) => `${c.cardId}:${c.count}`)
    .join('|')
}

/* ================================
 * Reading the portal's response
 * ================================ */

type Json = Record<string, unknown>

const asRecord = (v: unknown): Json | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null

const asNumber = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return null
}

const asString = (v: unknown): string | null => (typeof v === 'string' ? v : null)

/**
 * Read one `card_details[id].common` object.
 *
 * `common` may legitimately be absent - the portal has dropped details for a
 * card the deck still lists - so every field is recovered independently and the
 * name falls back to `#<cardId>`. A card we cannot describe is still a card in
 * the deck, and callers must be able to show it.
 */
function readCardMaster(cardId: number, common: Json | null): CardMaster {
  const type = common ? asNumber(common.type) : null
  const tribesRaw = common && Array.isArray(common.tribes) ? common.tribes : []

  return {
    cardId,
    name: (common && asString(common.name)) ?? `#${cardId}`,
    cost: common ? asNumber(common.cost) : null,
    type,
    kind: cardKindFromType(type),
    cardClass: common ? asNumber(common.class) : null,
    rarity: common ? asNumber(common.rarity) : null,
    atk: common ? asNumber(common.atk) : null,
    life: common ? asNumber(common.life) : null,
    skillText: common ? asString(common.skill_text) : null,
    tribes: tribesRaw.map(asNumber).filter((n): n is number => n !== null),
    deckEnabledNum: common ? asNumber(common.deck_enabled_num) : null,
    imageHash: common ? asString(common.card_image_hash) : null,
    bannerHash: common ? asString(common.card_banner_image_hash) : null,
    isToken: common ? common.is_token === true : false
  }
}

/**
 * Turn one `data` payload - from `DeckCode/getDeck` or `deckHashDetail`, which
 * return the same shape - into a `DeckImportPreview`.
 *
 * Reads defensively on purpose. Every field the UI needs to let the user
 * *continue* is recovered independently, so a portal change that drops or
 * renames one thing costs that thing and not the whole import.
 */
export function normalizeDeckResponse(
  data: unknown,
  source: ParsedDeckInput
): DeckImportPreview | null {
  const d = asRecord(data)
  if (!d) return null

  const deckCardNum = asRecord(d.deck_card_num)
  if (!deckCardNum) return null

  const sortList = Array.isArray(d.sort_card_id_list) ? d.sort_card_id_list : []
  const details = asRecord(d.card_details) ?? {}

  // Card order comes from sort_card_id_list when present, because that is the
  // order the portal displays. deck_card_num is the authority on which cards
  // are actually in the deck, so anything it holds that the sort list missed is
  // appended rather than dropped.
  const orderedIds: number[] = []
  const seen = new Set<number>()
  for (const raw of sortList) {
    const id = asNumber(raw)
    if (id !== null && !seen.has(id)) {
      seen.add(id)
      orderedIds.push(id)
    }
  }
  for (const key of Object.keys(deckCardNum)) {
    const id = asNumber(key)
    if (id !== null && !seen.has(id)) {
      seen.add(id)
      orderedIds.push(id)
    }
  }

  let partial = false
  const cards: DeckImportCard[] = []

  for (const cardId of orderedIds) {
    const count = asNumber(deckCardNum[String(cardId)]) ?? 0
    if (count <= 0) continue

    const common = asRecord(asRecord(details[String(cardId)])?.common)
    if (!common) partial = true

    cards.push({ ...readCardMaster(cardId, common), count })
  }

  if (cards.length === 0) return null

  const manaCurve: Record<number, number> = {}
  const counts = { follower: 0, spell: 0, amulet: 0 }
  for (const c of cards) {
    if (c.cost !== null) manaCurve[c.cost] = (manaCurve[c.cost] ?? 0) + c.count
    if (c.kind) counts[c.kind] += c.count
  }

  const classId = asNumber(d.class_id)
  const className = classId !== null ? (CLASS_ID_TO_NAME[classId] ?? null) : null
  if (className === null) partial = true

  return {
    source,
    hash: source.kind === 'hash' ? source.value : null,
    classId,
    className,
    battleFormat: asNumber(d.battle_format),
    keyCardId: cards[0]?.cardId ?? null,
    cards,
    totalCards: cards.reduce((sum, c) => sum + c.count, 0),
    manaCurve,
    counts,
    fingerprint: fingerprintDeck(cards),
    partial,
    raw: JSON.stringify(data)
  }
}

/**
 * Read a `/web/DeckBuilder/cards` response into a pool.
 *
 * The endpoint answers for "neutral plus one class" - it rejects a request for
 * every class at once - so a full pool is one call per class, and the caller is
 * what stitches them together. Each card carries its own `cardClass`, so the
 * neutral half does not need separating here.
 *
 * Token cards are dropped: they exist in the response because other cards
 * summon them, but they cannot be put in a deck, and a pool that offers them
 * offers something the game will reject.
 */
export function normalizeCardPoolResponse(data: unknown): PoolCard[] | null {
  const d = asRecord(data)
  if (!d) return null

  const details = asRecord(d.card_details)
  if (!details) return null

  const sortList = Array.isArray(d.sort_card_id_list) ? d.sort_card_id_list : []

  // Prefer the portal's order; fall back to whatever card_details holds so a
  // missing sort list costs the ordering and not the pool.
  const ids: number[] = []
  const seen = new Set<number>()
  for (const raw of sortList.length > 0 ? sortList : Object.keys(details)) {
    const id = asNumber(raw)
    if (id !== null && !seen.has(id)) {
      seen.add(id)
      ids.push(id)
    }
  }

  const cards: PoolCard[] = []
  for (const cardId of ids) {
    const common = asRecord(asRecord(details[String(cardId)])?.common)
    if (!common) continue
    const card = readCardMaster(cardId, common)
    if (card.isToken) continue
    cards.push({ ...card, sortIndex: cards.length })
  }

  return cards.length > 0 ? cards : null
}

/* ================================
 * Writing a deck back out
 * ================================ */

export interface DeckHashRequest {
  classId: number
  battleFormat: number
  /** The deck's cover card. The portal requires one; the first card is a fine default. */
  keyCardId: number
  cards: ReadonlyArray<{ cardId: number; count: number }>
}

/**
 * Build the body for `POST /web/DeckBuilder/getDeckHash`.
 *
 * The card list goes as FLAT NUMBERED PAIRS - `card_id1` / `card_num1`,
 * `card_id2` / `card_num2`, and so on - one pair per distinct card. This is not
 * documented anywhere and is not guessable: arrays, comma-separated ids and
 * form encoding were all tried and all rejected.
 *
 * The dangerous part is the failure mode. A wrong shape does not return an
 * error - it returns `result_code: 1` with `data.hash` set to the EMPTY STRING,
 * which reads as success to anything that only checks the result code. Callers
 * must treat an empty hash as a failure, and the smoke test pins the round trip
 * for exactly this reason.
 *
 * Cards are sorted by id so the same deck always produces the same body, which
 * is what makes the round trip testable at all.
 */
export function buildDeckHashPayload(deck: DeckHashRequest): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    // The portal sends these from its own editor; a deck being encoded for a
    // share code has no name and no id of its own.
    name: '',
    is_published: 1,
    status: 1,
    class_id: deck.classId,
    deck_id: null,
    battle_format: deck.battleFormat,
    key_card_id: deck.keyCardId
  }

  const cards = [...deck.cards].filter((c) => c.count > 0).sort((a, b) => a.cardId - b.cardId)

  cards.forEach((card, index) => {
    payload[`card_id${index + 1}`] = card.cardId
    payload[`card_num${index + 1}`] = card.count
  })

  return payload
}

/**
 * How long a published deck code lives.
 *
 * Three minutes from issue, then it is dead and recycled to somebody else's
 * deck. The portal's own page re-publishes every 60 seconds to keep one alive
 * while the page is open, which is the only way to give a user time to switch to
 * the game and type it.
 */
export const DECK_CODE_TTL_MS = 3 * 60_000
export const DECK_CODE_RENEW_MS = 60_000

/* ================================
 * Naming
 * ================================ */

/** The deck name column's limit, enforced by the form. */
export const DECK_NAME_MAX_LEN = 8

/**
 * A name to pre-fill the import form with.
 *
 * The portal returns no deck name - neither endpoint carries one - so something
 * has to be invented. It is pre-filled rather than required because a deck code
 * dies three minutes after it is issued, and every mandatory field between the
 * paste and the save is another way to run out of time.
 *
 * Month and day only, and no separator: the form allows eight characters, and
 * the longest class label is already four of them.
 */
export function suggestDeckName(classLabel: string, at: Date): string {
  const m = String(at.getMonth() + 1).padStart(2, '0')
  const d = String(at.getDate()).padStart(2, '0')
  return `${classLabel}${m}${d}`.slice(0, DECK_NAME_MAX_LEN)
}
