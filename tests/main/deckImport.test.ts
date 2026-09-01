/**
 * The pure half of deck import: what the user pasted, and what the portal said.
 *
 * The fixture is a real `deckHashDetail` response with the flavour text and
 * unused sections stripped. Keeping a real one matters more here than a tidy
 * hand-written one, because the two lookup tables under test were derived from
 * responses rather than read from documentation.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  BattleFormat,
  CLASS_ID_TO_NAME,
  CLASS_NAME_TO_ID,
  cardKindFromType,
  DECK_NAME_MAX_LEN,
  fingerprintDeck,
  normalizeDeckInput,
  normalizeDeckResponse,
  parseDeckInput,
  shareUrlForHash,
  suggestDeckName
} from '../../src/shared/deckImport'
import { ClassName } from '../../src/shared/domain'

const FIXTURE = JSON.parse(
  readFileSync(path.join(process.cwd(), 'tests/fixtures/deck-import/nemesis-hash.json'), 'utf8')
) as { data: Record<string, unknown> }

const HASH =
  '1.7.cQnG.cQnG.cR2I.cR2I.di4E.dzA8.dzA8.eKrc.eKrc.eLN-.eLN-.eLN-.eLae.eLae.eLae.ejG6.ejG6.ejlM.ejlM.ejlM.ej--.ej--.ej--.ej_8.ej_8.ej_8.f5jk.f5jk.f5jk.f69s.f69s.f69s.fUq8.fUq8.fUq8.fslO.fslO.fslO.ftEe.ftEe'

const hashSource = { kind: 'hash' as const, value: HASH }

describe('parseDeckInput', () => {
  it('reads a bare 4-character deck code', () => {
    expect(parseDeckInput('ufj1')).toEqual({ kind: 'code', value: 'ufj1' })
  })

  it('reads a bare long hash', () => {
    expect(parseDeckInput(HASH)).toEqual({ kind: 'hash', value: HASH })
  })

  it('pulls the hash out of a share link, whatever the language prefix', () => {
    for (const lang of ['cht', 'ja', 'en']) {
      expect(
        parseDeckInput(`https://shadowverse-wb.com/${lang}/deck/detail/?hash=${HASH}`)
      ).toEqual({ kind: 'hash', value: HASH })
    }
  })

  it('pulls a deck code out of a builder link', () => {
    expect(
      parseDeckInput(
        'https://shadowverse-wb.com/cht/deck/build_edit/?battle_format=2&class=3&deck_code=ufj1'
      )
    ).toEqual({ kind: 'code', value: 'ufj1' })
  })

  it('normalises what a paste picks up', () => {
    // Full-width digits and letters are what a code copied with a CJK IME
    // active actually looks like: four characters that read correctly and
    // match nothing.
    expect(parseDeckInput('　ｕｆｊ１ ')).toEqual({ kind: 'code', value: 'ufj1' })
    expect(parseDeckInput(`\u200Bufj1\u200B`)).toEqual({ kind: 'code', value: 'ufj1' })
    expect(normalizeDeckInput('  ufj1\n')).toBe('ufj1')
  })

  it('rejects anything that is neither', () => {
    for (const bad of ['', '   ', 'ufj', 'ufj12', 'hello world', 'https://example.com/?hash=abc']) {
      expect(parseDeckInput(bad), bad).toBeNull()
    }
  })

  it('rejects a link to another host even when it carries a valid hash', () => {
    expect(parseDeckInput(`https://evil.example/cht/deck/detail/?hash=${HASH}`)).toBeNull()
  })
})

describe('portal lookup tables', () => {
  // These are reverse-engineered, not documented. classMap.ts happens to use
  // the same names in a different order, so an index-based mapping silently
  // swaps bishop and nightmare - this is the test that would catch it.
  it('maps class_id without reusing classMap ordering', () => {
    expect(CLASS_ID_TO_NAME[5]).toBe(ClassName.nightmare)
    expect(CLASS_ID_TO_NAME[6]).toBe(ClassName.bishop)
    expect(CLASS_ID_TO_NAME).toEqual({
      1: ClassName.elf,
      2: ClassName.royal,
      3: ClassName.witch,
      4: ClassName.dragon,
      5: ClassName.nightmare,
      6: ClassName.bishop,
      7: ClassName.nemesis
    })
  })

  it('round-trips class id and name', () => {
    for (const [id, name] of Object.entries(CLASS_ID_TO_NAME)) {
      expect(CLASS_NAME_TO_ID[name]).toBe(Number(id))
    }
  })

  it('treats both amulet types as amulets', () => {
    expect(cardKindFromType(1)).toBe('follower')
    expect(cardKindFromType(4)).toBe('spell')
    expect(cardKindFromType(2)).toBe('amulet')
    expect(cardKindFromType(3)).toBe('amulet')
  })

  it('returns null for a type it does not know, rather than guessing a bucket', () => {
    expect(cardKindFromType(99)).toBeNull()
    expect(cardKindFromType(null)).toBeNull()
  })

  it('numbers the formats the way the portal does', () => {
    expect(BattleFormat.rotation).toBe(1)
    expect(BattleFormat.unlimited).toBe(2)
  })
})

describe('fingerprintDeck', () => {
  it('does not depend on card order', () => {
    const a = fingerprintDeck([
      { cardId: 20, count: 3 },
      { cardId: 10, count: 1 }
    ])
    const b = fingerprintDeck([
      { cardId: 10, count: 1 },
      { cardId: 20, count: 3 }
    ])
    expect(a).toBe(b)
    expect(a).toBe('10:1|20:3')
  })

  it('separates decks that differ by a single copy', () => {
    expect(fingerprintDeck([{ cardId: 10, count: 2 }])).not.toBe(
      fingerprintDeck([{ cardId: 10, count: 3 }])
    )
  })

  it('ignores cards with no copies', () => {
    expect(
      fingerprintDeck([
        { cardId: 10, count: 1 },
        { cardId: 20, count: 0 }
      ])
    ).toBe('10:1')
  })
})

describe('normalizeDeckResponse', () => {
  it('reads a real response', () => {
    const preview = normalizeDeckResponse(FIXTURE.data, hashSource)!
    expect(preview).not.toBeNull()

    expect(preview.classId).toBe(7)
    expect(preview.className).toBe(ClassName.nemesis)
    expect(preview.totalCards).toBe(40)
    expect(preview.cards).toHaveLength(16)
    expect(preview.partial).toBe(false)
    expect(preview.hash).toBe(HASH)
  })

  it("keeps each card's own class, not the deck's", () => {
    const preview = normalizeDeckResponse(FIXTURE.data, hashSource)!
    // The deck is nemesis (7) but holds neutral cards (0). Filing those under
    // the deck's class would misplace them in the card pool.
    const classes = new Set(preview.cards.map((c) => c.cardClass))
    expect(classes.has(0)).toBe(true)
    expect([...classes].every((c) => c === 0 || c === preview.classId)).toBe(true)
  })

  it('derives the same follower/spell/amulet split the portal reports', () => {
    const preview = normalizeDeckResponse(FIXTURE.data, hashSource)!
    const d = FIXTURE.data as Record<string, number>
    expect(preview.counts).toEqual({
      follower: d.num_follower,
      spell: d.num_spell,
      amulet: d.num_amulet
    })
  })

  it('gives exact cost buckets rather than the portal collapsed one', () => {
    const preview = normalizeDeckResponse(FIXTURE.data, hashSource)!
    const summed = Object.values(preview.manaCurve).reduce((a, b) => a + b, 0)
    expect(summed).toBe(40)
    // The portal folds everything from 8 upwards into a single "8" bucket; ours
    // must keep the real costs so a curve drawn from it is not a lie.
    const official = (FIXTURE.data as { mana_curve: Record<string, number> }).mana_curve
    expect(Object.keys(official)).not.toEqual(Object.keys(preview.manaCurve))
  })

  it('degrades to partial when card details are missing, instead of failing', () => {
    const data = JSON.parse(JSON.stringify(FIXTURE.data))
    const firstId = String(data.sort_card_id_list[0])
    delete data.card_details[firstId]

    const preview = normalizeDeckResponse(data, hashSource)!
    expect(preview).not.toBeNull()
    expect(preview.partial).toBe(true)
    expect(preview.totalCards).toBe(40)
    expect(preview.cards.find((c) => String(c.cardId) === firstId)?.name).toBe(`#${firstId}`)
  })

  it('keeps cards that deck_card_num lists but the sort order forgot', () => {
    const data = JSON.parse(JSON.stringify(FIXTURE.data))
    const dropped = data.sort_card_id_list.pop()
    const preview = normalizeDeckResponse(data, hashSource)!
    expect(preview.cards.map((c) => c.cardId)).toContain(dropped)
    expect(preview.totalCards).toBe(40)
  })

  it('flags an unknown class as partial rather than inventing one', () => {
    const data = { ...FIXTURE.data, class_id: 99 }
    const preview = normalizeDeckResponse(data, hashSource)!
    expect(preview.className).toBeNull()
    expect(preview.partial).toBe(true)
  })

  it('returns null when there is no card list at all', () => {
    expect(normalizeDeckResponse(null, hashSource)).toBeNull()
    expect(normalizeDeckResponse({}, hashSource)).toBeNull()
    expect(normalizeDeckResponse({ deck_card_num: {} }, hashSource)).toBeNull()
  })

  it('reports no hash for a code import, because a code is not a hash', () => {
    const preview = normalizeDeckResponse(FIXTURE.data, { kind: 'code', value: 'ufj1' })!
    expect(preview.hash).toBeNull()
    expect(preview.source).toEqual({ kind: 'code', value: 'ufj1' })
  })
})

describe('naming and links', () => {
  it('suggests a dated name so nothing is required before saving', () => {
    expect(suggestDeckName('復仇者', new Date(2026, 7, 31))).toBe('復仇者0831')
  })

  it('keeps the suggestion inside the form limit for the longest class label', () => {
    // 皇家護衛 is four characters, which with MMDD is exactly the limit.
    const name = suggestDeckName('皇家護衛', new Date(2026, 7, 31))
    expect(name).toBe('皇家護衛0831')
    expect([...name]).toHaveLength(DECK_NAME_MAX_LEN)
  })

  it('builds a share link that survives the deck code expiring', () => {
    expect(shareUrlForHash(HASH)).toBe(
      `https://shadowverse-wb.com/cht/deck/detail/?hash=${encodeURIComponent(HASH)}`
    )
  })
})
