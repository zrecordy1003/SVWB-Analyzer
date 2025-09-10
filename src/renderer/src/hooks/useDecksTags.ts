import { useCallback, useEffect, useRef, useState } from 'react'

export function useDecksTags(staleMs = 1000) {
  const [allDecks, setAllDecks] = useState([])
  const [allTags, setAllTags] = useState([])
  const [allCategories, setAllCategories] = useState([])
  const [loadingDecks, setLoadingDecks] = useState(false)
  const [loadingTags, setLoadingTags] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>(null)

  const lastDecksFetchedAt = useRef<number>(0)
  const lastTagsFetchedAt = useRef<number>(0)

  const reload = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const [decks, tags, cats] = await Promise.all([
        window.electron.ipcRenderer.invoke('decks:all'),
        window.electron.ipcRenderer.invoke('tags:list'),
        window.electron.ipcRenderer.invoke('deckCategories:all')
      ])

      const catMap = new Map()
      cats.data.forEach((c) => c && catMap.set(c.id, c))

      const enriched = decks.data.map((d) => {
        // console.log('dd', d)
        const cat = d.categoryId != null ? catMap.get(d.categoryId) : undefined
        return {
          id: d.id,
          name: d.name,
          classId: d.class ?? null, // 後端是 `class`，前端統一用 `classId`
          deckCategoryId: d.categoryId ?? null, // 後端是 `categoryId`
          categoryName: cat?.name ?? null,
          categorySort: cat?.sort ?? null
        }
      })

      // 依分類排序（sort -> name），再依牌組名稱排序
      enriched.sort((a, b) => {
        const as = a.categorySort ?? 9999
        const bs = b.categorySort ?? 9999
        if (as !== bs) return as - bs
        const an = (a.categoryName ?? '').localeCompare(b.categoryName ?? '')
        if (an !== 0) return an
        return a.name.localeCompare(b.name)
      })

      setAllDecks(enriched)
      setAllTags(tags)
      setAllCategories(cats.data)
    } catch (e) {
      setError(e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    reload()
  }, [])

  const fetchDecks = useCallback(
    async (force = false) => {
      if (!force && Date.now() - lastDecksFetchedAt.current < staleMs) return
      setLoadingDecks(true)
      try {
        setError(null)
        const decks = await window.electron.ipcRenderer.invoke('decks:all')
        const cats = await window.electron.ipcRenderer.invoke('deckCategories:all')
        if (!decks.ok) throw new Error(decks.error)
        const catMap = new Map()
        cats.data.forEach((c) => c && catMap.set(c.id, c))

        const enriched = decks.data.map((d) => {
          // console.log('dd', d)
          const cat = d.categoryId != null ? catMap.get(d.categoryId) : undefined
          return {
            id: d.id,
            name: d.name,
            classId: d.class ?? null, // 後端是 `class`，前端統一用 `classId`
            deckCategoryId: d.categoryId ?? null, // 後端是 `categoryId`
            categoryName: cat?.name ?? null,
            categorySort: cat?.sort ?? null
          }
        })

        // 依分類排序（sort -> name），再依牌組名稱排序
        enriched.sort((a, b) => {
          const as = a.categorySort ?? 9999
          const bs = b.categorySort ?? 9999
          if (as !== bs) return as - bs
          const an = (a.categoryName ?? '').localeCompare(b.categoryName ?? '')
          if (an !== 0) return an
          return a.name.localeCompare(b.name)
        })
        setAllDecks(enriched ?? [])

        lastDecksFetchedAt.current = Date.now()
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
      if (!force && Date.now() - lastTagsFetchedAt.current < staleMs) return
      setLoadingTags(true)
      try {
        setError(null)
        const res = await window.electron.ipcRenderer.invoke('tags:list')
        setAllTags(res ?? [])

        lastTagsFetchedAt.current = Date.now()
      } catch (e: any) {
        setError(e?.message ?? '取得標籤失敗')
      } finally {
        setLoadingTags(false)
      }
    },
    [staleMs]
  )

  // 初始化抓一次
  // useEffect(() => {
  //   void fetchDecks(true)
  //   void fetchTags(true)
  // }, [fetchDecks, fetchTags])

  return {
    allDecks,
    allTags,
    allCategories,
    loading,
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
