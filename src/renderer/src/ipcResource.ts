/**
 * One IPC channel's answers, cached and shared across every consumer.
 *
 * # What this is generalising
 *
 * `hooks/useDecksTags.ts` is a hand-written query cache and a good one:
 * `useSyncExternalStore` over a module-level snapshot, in-flight
 * de-duplication, one broadcast listener shared by all consumers, and - the
 * part that is easy to miss - "mark stale but keep the data", because
 * discarding it made every subscriber render an empty snapshot for the ~50ms
 * until the refetch landed.
 *
 * The problem was that it only served reference data. Everything else fetched
 * per component: `DeckPerformance` had TWO effects issuing the same
 * `decks:stats` query - one on a parameter change, one on `matches:needRefetch`
 * - with the error handling written twice and no de-duplication between them.
 * `useCardStats` had its own third variation, including a request sequence
 * counter to stop a late answer overwriting a newer one.
 *
 * This is that pattern with one thing added: a KEY. Reference data is one
 * value; stats are one value per filter, so the cache is a map and the hook
 * takes the arguments it wants.
 *
 * Deliberately not TanStack Query. `useDecksTags` demonstrated the pattern is
 * sufficient here, and its behaviour is tuned to facts about this app - a local
 * IPC round trip is sub-10ms, and invalidation arrives as a broadcast rather
 * than being time-based. A new dependency plus a new mental model would buy
 * retries, window-focus refetching and devtools, none of which this needs.
 *
 * # Two things the key gives for free
 *
 * A late answer cannot overwrite a newer one, because it writes to ITS key and
 * the hook reads the key it currently wants. `useCardStats`'s sequence counter
 * is gone rather than reimplemented.
 *
 * And two components asking the same question share one request, which they
 * previously could not.
 */
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'

import type { IpcArgs, IpcChannel, IpcResult } from '@shared/ipc'
import { invokeIpc } from '@renderer/ipc'

type Entry<T> = {
  data: T | null
  error: string | null
  loading: boolean
  /** 0 means stale. Never cleared by invalidation, only by a new answer. */
  fetchedAt: number
}

const EMPTY: Entry<never> = { data: null, error: null, loading: false, fetchedAt: 0 }

export type IpcResourceOptions<C extends IpcChannel, T> = {
  channel: C
  /**
   * Unwrap the `Res<T>` envelope, throwing on failure.
   *
   * Explicit rather than detected from the type: about half the channels use
   * the envelope and half answer directly, and a `select` that throws puts the
   * failure on the path that already handles failures. Omit it for a channel
   * whose result IS the data.
   */
  select?: (result: IpcResult<C>) => T
  /**
   * Broadcast channels that make every cached answer stale.
   *
   * Usually `['matches:needRefetch']`: a game that just ended should show up
   * without the user touching a filter.
   */
  invalidateOn?: readonly string[]
  /**
   * How long an answer is treated as fresh. Short by default - this is a
   * cache against duplicate work within a render pass and across components,
   * not a substitute for invalidation.
   */
  staleMs?: number
}

export type IpcResourceState<T> = {
  data: T | null
  loading: boolean
  error: string | null
  /** Fetch again, ignoring freshness. */
  refetch: () => void
}

export function createIpcResource<C extends IpcChannel, T = IpcResult<C>>(
  options: IpcResourceOptions<C, T>
) {
  const { channel, select, invalidateOn = [], staleMs = 1000 } = options

  const entries = new Map<string, Entry<T>>()
  const listeners = new Map<string, Set<() => void>>()
  const inFlight = new Map<string, Promise<void>>()

  /**
   * The cache key.
   *
   * `JSON.stringify` of the arguments, which is stable for these payloads: a
   * `Date` serialises to its ISO string, and the callers build their filter
   * objects as literals so the property order does not move. It would NOT be
   * stable for an object assembled by spreading in a varying order - worth
   * knowing before using this for something assembled that way.
   */
  const keyOf = (args: IpcArgs<C>): string => JSON.stringify(args)

  function emit(key: string): void {
    const set = listeners.get(key)
    if (!set) return
    for (const listener of set) listener()
  }

  function subscribe(key: string | null, listener: () => void): () => void {
    if (!key) return () => {}
    const set = listeners.get(key) ?? new Set()
    set.add(listener)
    listeners.set(key, set)
    return () => {
      set.delete(listener)
      if (set.size > 0) return
      listeners.delete(key)
      /**
       * Released, so drop it. Keeps the map bounded without a policy to get
       * wrong: a user working through filter combinations would otherwise
       * leave one cached array per combination for the life of the session.
       *
       * The cost is that returning to a previous filter refetches, and it is
       * affordable precisely because it is a local IPC round trip. What must
       * NOT flicker - the same consumer moving from one filter to the next -
       * is handled in the hook, which holds the last data it showed.
       */
      entries.delete(key)
      inFlight.delete(key)
    }
  }

  function set(key: string, patch: Partial<Entry<T>>): void {
    const current = entries.get(key) ?? (EMPTY as Entry<T>)
    // A new object, because `useSyncExternalStore` compares by identity - but
    // only when something actually changed, or every subscriber re-renders for
    // a change none of them can see.
    entries.set(key, { ...current, ...patch })
    emit(key)
  }

  async function load(key: string, args: IpcArgs<C>): Promise<void> {
    const existing = inFlight.get(key)
    if (existing) return existing

    const request = (async () => {
      set(key, { loading: true })
      try {
        const result = await invokeIpc(channel, ...args)
        const data = select ? select(result) : (result as unknown as T)
        set(key, { data, error: null, loading: false, fetchedAt: Date.now() })
      } catch (e) {
        // The data is left in place. A failed refresh should not blank a screen
        // that is showing the last good answer.
        set(key, {
          error: e instanceof Error ? e.message : String(e),
          loading: false,
          fetchedAt: Date.now()
        })
      } finally {
        inFlight.delete(key)
      }
    })()

    inFlight.set(key, request)
    return request
  }

  function ensure(key: string, args: IpcArgs<C>, force = false): void {
    const entry = entries.get(key)
    if (!force && entry && Date.now() - entry.fetchedAt < staleMs) return
    void load(key, args)
  }

  /**
   * Mark everything stale and refresh what someone is looking at.
   *
   * `fetchedAt = 0` rather than a delete, for the reason `useDecksTags`
   * documents: the last known-good answer stays on screen until the real one
   * replaces it. And only SUBSCRIBED keys are refetched - firing a request for
   * every filter the user has ever tried would be the obvious way to make an
   * invalidation expensive.
   */
  function invalidate(): void {
    for (const [key, entry] of entries) entries.set(key, { ...entry, fetchedAt: 0 })
    for (const key of listeners.keys()) {
      const args = JSON.parse(key) as IpcArgs<C>
      void load(key, args)
    }
  }

  /**
   * One listener per resource, registered lazily and never removed.
   *
   * The same trade `useDecksTags` makes: N mounted consumers share one
   * subscription rather than each registering its own and racing the others.
   */
  let listening = false
  function ensureListening(): void {
    if (listening || invalidateOn.length === 0) return
    listening = true
    for (const event of invalidateOn) {
      window.electron?.ipcRenderer.on(event, () => invalidate())
    }
  }

  /**
   * `null` arguments mean "not ready to ask yet" - a page still restoring its
   * saved filters - and issue no request. It is a distinct state from an empty
   * filter, which is a real query.
   */
  function use(args: IpcArgs<C> | null): IpcResourceState<T> {
    ensureListening()
    const key = args ? keyOf(args) : null

    const entry = useSyncExternalStore(
      useCallback((listener: () => void) => subscribe(key, listener), [key]),
      useCallback(
        () => (key ? (entries.get(key) ?? (EMPTY as Entry<T>)) : (EMPTY as Entry<T>)),
        [key]
      )
    )

    useEffect(() => {
      if (key && args) ensure(key, args)
      // `key` is the serialised arguments, so it is the only dependency that
      // matters; depending on `args` itself would refetch for every new object
      // identity the caller happens to build.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key])

    /**
     * The last answer this consumer displayed, held across a key change.
     *
     * Without it, moving from one filter to the next renders `null` until the
     * new answer lands, and a deck-performance page that empties and refills on
     * every filter click is the flicker `useDecksTags` was fixed to avoid. The
     * component keeps its numbers and `loading` says a new set is coming.
     */
    const lastGood = useRef<T | null>(null)
    if (entry.data !== null) lastGood.current = entry.data

    const refetch = useCallback(() => {
      if (key && args) ensure(key, args, true)
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key])

    return {
      data: entry.data ?? lastGood.current,
      loading: entry.loading,
      error: entry.error,
      refetch
    }
  }

  return { use, invalidate }
}

/**
 * `Res<T>` in, `T` out, throwing the message on failure.
 *
 * Every enveloped channel wants exactly this, and writing it at each call site
 * is how the four private copies of `wrap()` happened on the main side.
 */
export function unwrapRes<T>(result: { ok: true; data: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(result.error)
  return result.data
}
