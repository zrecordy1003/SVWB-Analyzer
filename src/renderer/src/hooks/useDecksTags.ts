import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { currentDecks } from '@renderer/components/DeckCards/deckVersions'
import { invokeIpc } from '@renderer/ipc'
import type { ClassName } from '@shared/domain'

export type DeckLite = {
  id: number
  name: string
  classId: ClassName | null
  deckCategoryId: string | null
  categoryName: string | null
  categorySort: number | null
  /** Banner of the card that represents the deck - see `pickHeroCard` in main. */
  heroBannerHash: string | null
  /** Null when the deck has no card list, which is not the same as three zeroes. */
  composition: { follower: number; spell: number; amulet: number } | null
  /** Epoch ms, so consumers can order by "newest" without re-parsing a Date. */
  createdAt: number
  /**
   * Deck versioning (docs/deck-versioning-plan.md). `familyId` ties the
   * generations of one deck together; `archivedAt` (epoch ms) non-null means
   * the row was "deleted" while matches still reference it.
   */
  familyId: number | null
  archivedAt: number | null
  isDefault: boolean
}

type TagLite = { id: number; name: string }
type CategoryLite = { id: string; name: string; sort?: number | null }

type ReferenceCache = {
  /** Every version of every deck, archived rows included. */
  deckVersions: DeckLite[]
  /** One row per live family - what pickers and the match list want. */
  decks: DeckLite[]
  tags: TagLite[]
  categories: CategoryLite[]
  fetchedAt: number
}

let referenceCache: ReferenceCache | null = null
let referenceInFlight: Promise<ReferenceCache> | null = null
let decksInFlight: Promise<Pick<ReferenceCache, 'decks' | 'deckVersions' | 'categories'>> | null =
  null
let tagsInFlight: Promise<TagLite[]> | null = null

/**
 * Subscribers to the cache snapshot, for `useSyncExternalStore`. Kept as a
 * module-level `Set` (not React state) so every `useDecksTags()` instance
 * reads the same object identity - the point of the store is that N mounted
 * consumers cost one fetch, not N.
 */
const listeners = new Set<() => void>()
function emitChange(): void {
  for (const listener of listeners) listener()
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
function getSnapshot(): ReferenceCache | null {
  return referenceCache
}

/**
 * Mark the cache stale WITHOUT throwing the data away.
 *
 * Dropping it (`referenceCache = null`) made every subscriber render an empty
 * snapshot for the ~50ms until the refetch landed, and any re-render inside
 * that window - `decks:setDefaultForClass` resolving and clearing its busy id
 * is one - repainted the deck grid from nothing. That is the flicker when you
 * set a default: the grid empties and refills, and the optimistic star flips
 * back and forth on the way.
 *
 * `fetchedAt = 0` makes every staleness check treat it as expired, so the
 * refetch still happens; the last known-good data just stays on screen until
 * the real answer replaces it. Written in place rather than as a new object:
 * `getSnapshot` must keep returning the same identity until there is actually
 * new data, or `useSyncExternalStore` re-renders every subscriber for a change
 * none of them can see.
 */
function invalidateReferenceCache(): void {
  if (referenceCache) referenceCache.fetchedAt = 0
}

/**
 * Flip `deckId` to the default for its class, clearing every other deck of
 * that class, and notify subscribers immediately - ahead of the round trip
 * that will confirm it.
 *
 * Scoped to this one write because it is the one where the UI needs to feel
 * instant: "設為預設" flips a star the user just clicked. Everything else
 * (create/edit/delete) rides the plain broadcast-then-refetch path - local
 * IPC + SQLite round trips are sub-10ms, well under what an optimistic
 * update would be worth, and getting fork/archive semantics right locally
 * would mean re-implementing rules main already owns.
 */
function setDefaultOptimistic(deckId: number, classId: ClassName | null): void {
  if (!referenceCache) return
  const apply = (list: DeckLite[]): DeckLite[] =>
    list.map((d) => {
      if (d.id === deckId) return { ...d, isDefault: true }
      if (d.classId === classId && d.isDefault) return { ...d, isDefault: false }
      return d
    })
  referenceCache = {
    ...referenceCache,
    decks: apply(referenceCache.decks),
    deckVersions: apply(referenceCache.deckVersions)
  }
  emitChange()
}

/**
 * `reference-data:changed` fires once per write, but a multi-step commit
 * (import writes cards, then the deck) can still fan out into a couple of
 * events close together. One module-level listener, debounced, means every
 * mounted `useDecksTags()` consumer shares one invalidate-and-refetch instead
 * of each re-registering its own handler and racing the others.
 */
let debounceTimer: ReturnType<typeof setTimeout> | null = null
function scheduleRefetch(): void {
  invalidateReferenceCache()
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    void loadReferenceData(true)
      .then(emitChange)
      .catch(() => emitChange())
  }, 50)
}

let ipcListenerRegistered = false
function ensureIpcListener(): void {
  if (ipcListenerRegistered) return
  ipcListenerRegistered = true
  window.electron?.ipcRenderer.on('reference-data:changed', scheduleRefetch)
}

const toMs = (value: unknown): number | null => {
  if (value == null) return null
  const t = new Date(value as string | number | Date).getTime()
  return Number.isNaN(t) ? null : t
}

function enrichDecks(deckRows: any[], categories: CategoryLite[]): DeckLite[] {
  const catMap = new Map<string, CategoryLite>()
  categories.forEach((c) => c && catMap.set(c.id, c))

  const enriched = deckRows.map((d) => {
    const cat = d.categoryId != null ? catMap.get(d.categoryId) : undefined
    return {
      id: d.id,
      name: d.name,
      classId: d.class ?? null,
      deckCategoryId: d.categoryId ?? null,
      categoryName: cat?.name ?? null,
      categorySort: cat?.sort ?? null,
      heroBannerHash: d.heroBannerHash ?? null,
      composition: d.composition ?? null,
      createdAt: toMs(d.createdAt) ?? 0,
      familyId: typeof d.familyId === 'number' ? d.familyId : null,
      archivedAt: toMs(d.archivedAt),
      isDefault: !!d.isDefault
    }
  })

  enriched.sort((a, b) => {
    const as = a.categorySort ?? 9999
    const bs = b.categorySort ?? 9999
    if (as !== bs) return as - bs
    const an = (a.categoryName ?? '').localeCompare(b.categoryName ?? '')
    if (an !== 0) return an
    return a.name.localeCompare(b.name)
  })

  return enriched
}

/**
 * One fetch for every version, then the "current decks" list is derived from
 * it. Asking `decks:all` twice (default scope and `'all'`) would cost a second
 * round trip and could disagree with itself if a fork landed in between; the
 * derivation is the same rule main applies, kept in `deckVersions.ts`.
 */
async function fetchDecks(): Promise<{ deckVersions: DeckLite[]; categories: CategoryLite[] }> {
  const [decksRes, catsRes] = await Promise.all([
    invokeIpc('decks:all', { scope: 'all' }),
    invokeIpc('deckCategories:all')
  ])
  if (!decksRes?.ok) throw new Error(decksRes?.error ?? '取得牌組失敗')
  if (!catsRes?.ok) throw new Error(catsRes?.error ?? '取得分類失敗')

  const categories = (catsRes.data ?? []) as CategoryLite[]
  return { deckVersions: enrichDecks(decksRes.data ?? [], categories), categories }
}

async function loadReferenceData(force = false, staleMs = 1000): Promise<ReferenceCache> {
  if (!force && referenceCache && Date.now() - referenceCache.fetchedAt < staleMs) {
    return referenceCache
  }
  if (!force && referenceInFlight) return referenceInFlight

  referenceInFlight = (async () => {
    const [{ deckVersions, categories }, tags] = await Promise.all([
      fetchDecks(),
      invokeIpc('tags:list')
    ])

    referenceCache = {
      deckVersions,
      decks: currentDecks(deckVersions),
      tags: (tags ?? []) as TagLite[],
      categories,
      fetchedAt: Date.now()
    }
    return referenceCache
  })().finally(() => {
    referenceInFlight = null
  })

  return referenceInFlight
}

async function loadDecks(force = false, staleMs = 1000) {
  if (!force && referenceCache && Date.now() - referenceCache.fetchedAt < staleMs) {
    return {
      decks: referenceCache.decks,
      deckVersions: referenceCache.deckVersions,
      categories: referenceCache.categories
    }
  }
  if (!force && decksInFlight) return decksInFlight

  decksInFlight = (async () => {
    const { deckVersions, categories } = await fetchDecks()
    const decks = currentDecks(deckVersions)
    referenceCache = {
      deckVersions,
      decks,
      tags: referenceCache?.tags ?? [],
      categories,
      fetchedAt: Date.now()
    }
    return { decks, deckVersions, categories }
  })().finally(() => {
    decksInFlight = null
  })

  return decksInFlight
}

async function loadTags(force = false, staleMs = 1000): Promise<TagLite[]> {
  if (!force && referenceCache && Date.now() - referenceCache.fetchedAt < staleMs) {
    return referenceCache.tags
  }
  if (!force && tagsInFlight) return tagsInFlight

  tagsInFlight = (async () => {
    const tags = await invokeIpc('tags:list')
    referenceCache = {
      deckVersions: referenceCache?.deckVersions ?? [],
      decks: referenceCache?.decks ?? [],
      tags: tags ?? [],
      categories: referenceCache?.categories ?? [],
      fetchedAt: Date.now()
    }
    return referenceCache.tags
  })().finally(() => {
    tagsInFlight = null
  })

  return tagsInFlight
}

const EMPTY_CACHE: ReferenceCache = {
  deckVersions: [],
  decks: [],
  tags: [],
  categories: [],
  fetchedAt: 0
}

/**
 * A thin `useSyncExternalStore` view over the module-level cache above.
 *
 * Every mounted instance shares one snapshot, one IPC listener (registered
 * once, lazily, by `ensureIpcListener`) and one in-flight fetch per write:
 * `DeckManagerControl`'s drawer staying open the whole session and a match
 * list mounting alongside it used to mean two independent `decks:all` +
 * `deckCategories:all` round trips per change; now it is one, regardless of
 * how many components ask.
 */
export function useDecksTags(staleMs = 1000) {
  ensureIpcListener()

  const cache = useSyncExternalStore(subscribe, getSnapshot) ?? EMPTY_CACHE
  const hasLoadedOnce = referenceCache !== null

  const [loadingDecks, setLoadingDecks] = useState(false)
  const [loadingTags, setLoadingTags] = useState(false)
  const [loading, setLoading] = useState(!hasLoadedOnce)
  const [error, setError] = useState<unknown>(null)

  // Kick off the first load if nothing has fetched yet; a later mount finds
  // the cache already warm (or a fetch already in flight) and does nothing.
  useEffect(() => {
    if (referenceCache) {
      setLoading(false)
      return
    }
    let mounted = true
    void loadReferenceData(false, staleMs)
      .then(() => {
        if (mounted) emitChange()
      })
      .catch((e) => {
        if (mounted) setError(e)
      })
      .finally(() => {
        if (mounted) setLoading(false)
      })
    return () => {
      mounted = false
    }
  }, [staleMs])

  const reload = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      await loadReferenceData(true, staleMs)
      emitChange()
    } catch (e) {
      setError(e)
    } finally {
      setLoading(false)
    }
  }, [staleMs])

  const fetchDecksState = useCallback(
    async (force = false) => {
      setLoadingDecks(true)
      try {
        setError(null)
        await loadDecks(force, staleMs)
        emitChange()
      } catch (e: any) {
        setError(e?.message ?? '取得牌組失敗')
      } finally {
        setLoadingDecks(false)
      }
    },
    [staleMs]
  )

  const fetchTags = useCallback(
    async (force = false) => {
      setLoadingTags(true)
      try {
        setError(null)
        await loadTags(force, staleMs)
        emitChange()
      } catch (e: any) {
        setError(e?.message ?? '取得標籤失敗')
      } finally {
        setLoadingTags(false)
      }
    },
    [staleMs]
  )

  return {
    /** Current version of every live family. Pickers and the match list read this. */
    allDecks: cache.decks,
    /** Every version row, archived included. The version UI reads this. */
    allDeckVersions: cache.deckVersions,
    allTags: cache.tags,
    allCategories: cache.categories,
    loading,
    loadingDecks,
    loadingTags,
    error,
    reload,
    refreshDecks: () => fetchDecksState(true),
    refreshTags: () => fetchTags(true),
    refetchAll: () => {
      fetchDecksState(true)
      fetchTags(true)
    },
    /** See `setDefaultOptimistic` - pairs with `decks:setDefaultForClass`. */
    setDefaultOptimistic
  }
}
