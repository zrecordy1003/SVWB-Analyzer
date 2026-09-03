import { shell } from 'electron'
import { store, type SupportState } from '../store.js'
import { getDb } from '../data/db/client.js'
import {
  SUPPORT_LAUNCH_MILESTONE,
  SUPPORT_MATCH_MILESTONE,
  supportUrl,
  type SupportLink,
  type SupportMilestone,
  type SupportSource
} from '../../shared/support.js'
import { handleIpc } from '../ipc/typed.js'

/**
 * The one-time support prompt.
 *
 * Two milestones, each allowed a single appearance for the lifetime of the
 * install: enough recorded matches that the tool has demonstrably been useful,
 * or enough launches that it has become part of the routine. Whichever comes
 * first shows once; the other can still show later. `optedOut` kills both.
 *
 * A milestone is marked shown the moment it is handed to the renderer, not when
 * the user reacts. Closing the toast without clicking is a real answer, and a
 * free tool that re-asks is worse than one that never asked.
 */

function readState(): SupportState {
  const state = store.get('support')
  // A config.json written by an older build has no `support` key at all, and
  // electron-store only fills defaults for keys it has never seen at the top
  // level - so normalise the shape rather than trusting it.
  return {
    optedOut: state?.optedOut === true,
    launchCount: typeof state?.launchCount === 'number' ? state.launchCount : 0,
    shown: Array.isArray(state?.shown) ? state.shown : []
  }
}

function writeState(next: SupportState): void {
  store.set('support', next)
}

/** Count this launch. Called once per startup, before any window exists. */
export function recordLaunch(): void {
  const state = readState()
  writeState({ ...state, launchCount: state.launchCount + 1 })
}

async function countMatches(): Promise<number> {
  try {
    const row = await getDb()
      .selectFrom('Match')
      .select(({ fn }) => fn.countAll<number>().as('n'))
      .executeTakeFirstOrThrow()
    return Number(row.n)
  } catch {
    // No database yet, or it failed to open. Not worth surfacing here: the
    // prompt is decoration, and the launch milestone still works.
    return 0
  }
}

/** Open a donation link in the user's browser. Never embedded in the app. */
export function openSupportLink(link: SupportLink, src: SupportSource): void {
  void shell.openExternal(supportUrl(link, src))
}

export function registerSupportIpc(): void {
  /**
   * Resolves to the milestone to show, or null. Marks it shown on the way out,
   * so a second window (or a reload) cannot replay it.
   */
  handleIpc('support:check', async () => {
    const state = readState()
    if (state.optedOut) return null

    const launchCount = state.launchCount
    const matchCount = await countMatches()

    const due: SupportMilestone[] = []
    if (matchCount >= SUPPORT_MATCH_MILESTONE) due.push('matches')
    if (launchCount >= SUPPORT_LAUNCH_MILESTONE) due.push('launches')

    // Matches first: "we recorded 100 games for you" is a stronger reason than
    // "you opened this 20 times".
    const reason = due.find((candidate) => !state.shown.includes(candidate))
    if (!reason) return null

    writeState({ ...state, shown: [...state.shown, reason] })
    return { reason, matchCount, launchCount }
  })

  handleIpc('support:optOut', () => {
    writeState({ ...readState(), optedOut: true })
  })
}
