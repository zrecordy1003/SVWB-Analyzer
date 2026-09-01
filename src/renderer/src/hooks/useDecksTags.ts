import { useCallback, useEffect, useState } from 'react'

type DeckLite = {
  id: number
  name: string
  classId: string | number | null
  deckCategoryId: string | null
  categoryName: string | null
  categorySort: number | null
  /** Banner of the card that represents the deck - see `pickHeroCard` in main. */
  heroBannerHash: string | null
  /** Null when the deck has no card list, which is not the same as three zeroes. */
  composition: { follower: number; spell: number; amulet: number } | null
  /** Epoch ms, so consumers can order by "newest" without re-parsing a Date. */
  createdAt: number
}

type TagLite = { id: number; name: string }
type CategoryLite = { id: string; name: string; sort?: number | null }

type ReferenceCache = {
  decks: DeckLite[]
  tags: TagLite[]
  categories: CategoryLite[]
  fetchedAt: number
}

let referenceCache: ReferenceCache | null = null
let referenceInFlight: Promise<ReferenceCache> | null = null
let decksInFlight: Promise<Pick<ReferenceCache, 'decks' | 'categories'>> | null = null
let tagsInFlight: Promise<TagLite[]> | null = null

function invalidateReferenceCache(): void {
  referenceCache = null
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
      createdAt: d.createdAt ? new Date(d.createdAt).getTime() : 0
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

async function loadReferenceData(force = false, staleMs = 1000): Promise<ReferenceCache> {
  if (!force && referenceCache && Date.now() - referenceCache.fetchedAt < staleMs) {
    return referenceCache
  }
  if (!force && referenceInFlight) return referenceInFlight

  referenceInFlight = (async () => {
    const [decksRes, tags, catsRes] = await Promise.all([
      window.electron.ipcRenderer.invoke('decks:all'),
      window.electron.ipcRenderer.invoke('tags:list'),
      window.electron.ipcRenderer.invoke('deckCategories:all')
    ])

    if (!decksRes?.ok) throw new Error(decksRes?.error ?? '取得牌組失敗')
    if (!catsRes?.ok) throw new Error(catsRes?.error ?? '取得分類失敗')

    const categories = (catsRes.data ?? []) as CategoryLite[]
    referenceCache = {
      decks: enrichDecks(decksRes.data ?? [], categories),
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
    return { decks: referenceCache.decks, categories: referenceCache.categories }
  }
  if (!force && decksInFlight) return decksInFlight

  decksInFlight = (async () => {
    const [decksRes, catsRes] = await Promise.all([
      window.electron.ipcRenderer.invoke('decks:all'),
      window.electron.ipcRenderer.invoke('deckCategories:all')
    ])
    if (!decksRes?.ok) throw new Error(decksRes?.error ?? '取得牌組失敗')
    if (!catsRes?.ok) throw new Error(catsRes?.error ?? '取得分類失敗')

    const categories = (catsRes.data ?? []) as CategoryLite[]
    const decks = enrichDecks(decksRes.data ?? [], categories)
    referenceCache = {
      decks,
      tags: referenceCache?.tags ?? [],
      categories,
      fetchedAt: Date.now()
    }
    return { decks, categories }
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
    const tags = (await window.electron.ipcRenderer.invoke('tags:list')) as TagLite[]
    referenceCache = {
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

export function useDecksTags(staleMs = 1000) {
  const [allDecks, setAllDecks] = useState<DeckLite[]>(() => referenceCache?.decks ?? [])
  const [allTags, setAllTags] = useState<TagLite[]>(() => referenceCache?.tags ?? [])
  const [allCategories, setAllCategories] = useState<CategoryLite[]>(
    () => referenceCache?.categories ?? []
  )
  const [loadingDecks, setLoadingDecks] = useState(false)
  const [loadingTags, setLoadingTags] = useState(false)
  const [loading, setLoading] = useState(!referenceCache)
  const [error, setError] = useState<unknown>(null)

  const reload = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const data = await loadReferenceData(true, staleMs)
      setAllDecks(data.decks)
      setAllTags(data.tags)
      setAllCategories(data.categories)
    } catch (e) {
      setError(e)
    } finally {
      setLoading(false)
    }
  }, [staleMs])

  useEffect(() => {
    let mounted = true
    const refresh = async (): Promise<void> => {
      try {
        setLoading(true)
        setError(null)
        const data = await loadReferenceData(false, staleMs)
        if (!mounted) return
        setAllDecks(data.decks)
        setAllTags(data.tags)
        setAllCategories(data.categories)
      } catch (e) {
        if (mounted) setError(e)
      } finally {
        if (mounted) setLoading(false)
      }
    }
    void refresh()

    const unsubscribe = window.electron?.ipcRenderer.on('reference-data:changed', () => {
      invalidateReferenceCache()
      void refresh()
    })

    return () => {
      mounted = false
      unsubscribe && unsubscribe()
    }
  }, [staleMs])

  const fetchDecks = useCallback(
    async (force = false) => {
      setLoadingDecks(true)
      try {
        setError(null)
        const data = await loadDecks(force, staleMs)
        setAllDecks(data.decks)
        setAllCategories(data.categories)
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
        const tags = await loadTags(force, staleMs)
        setAllTags(tags)
      } catch (e: any) {
        setError(e?.message ?? '取得標籤失敗')
      } finally {
        setLoadingTags(false)
      }
    },
    [staleMs]
  )

  return {
    allDecks,
    allTags,
    allCategories,
    loading,
    loadingDecks,
    loadingTags,
    error,
    reload,
    refreshDecks: () => fetchDecks(true),
    refreshTags: () => fetchTags(true),
    refetchAll: () => {
      fetchDecks(true)
      fetchTags(true)
    }
  }
}
