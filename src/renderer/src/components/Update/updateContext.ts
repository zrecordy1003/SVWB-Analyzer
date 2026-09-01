/**
 * The context behind [UpdateProvider], kept in its own file.
 *
 * Not a stylistic split: a module that exports both a component and a plain
 * function loses Fast Refresh for everything in it, because the refresh runtime
 * can no longer tell what is safe to swap. The provider stays a component-only
 * module; the hook and its types live here.
 */
import { createContext, useContext } from 'react'

export type PendingUpdate = {
  version: string
  /** Downloaded and waiting to be installed, rather than merely offered. */
  ready: boolean
}

export type UpdateContextValue = {
  /** The running version, for display. */
  appVersion: string
  /** The update this app knows about, or null. */
  pending: PendingUpdate | null
  /**
   * A check is in flight, from either surface.
   *
   * This exists so that "we are looking" has somewhere quiet to be said. It
   * used to be a dialog that opened on every background check - which is the
   * one thing an automatic check must never do.
   */
  checking: boolean
  /** Open the shared dialog on whatever is currently known. */
  show: () => void
}

export const UpdateContext = createContext<UpdateContextValue | null>(null)

export function useUpdateStatus(): UpdateContextValue {
  const value = useContext(UpdateContext)
  if (!value) throw new Error('useUpdateStatus must be used inside <UpdateProvider>')
  return value
}
