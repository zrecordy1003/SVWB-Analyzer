/**
 * The always-mounted half of the update flow: what the app knows about a new
 * version, and the one dialog that talks about it.
 *
 * This used to be `UpdateBackground`, which owned that state privately. It
 * became a provider when the sidebar needed to show the same thing, because the
 * two have to agree: dismissing the dialog must not lose the update, and the
 * sidebar entry must reopen *this* dialog rather than a second copy of it.
 *
 * The rule about interrupting the user is unchanged and still lives here. There
 * is no 'checking' and no 'already up to date' state, and a failed background
 * check stays in the log - all three used to open a dialog, which meant a popup
 * on every single launch for anyone with 自動檢查更新 on. A check the user
 * asked for reports all of that, in Settings.
 *
 * What it *does* now track from both surfaces is the bare fact that an update
 * exists, so a manual check in Settings also lights up the sidebar.
 */
import React, { useEffect, useRef, useState } from 'react'
import type { UpdateProgress, UpdateSummary } from '@shared/updates'
import UpdateDialog, { type UpdatePhase } from './UpdateDialog'
import { UpdateContext } from './updateContext'

export const UpdateProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [phase, setPhase] = useState<UpdatePhase>('available')
  const [open, setOpen] = useState(false)
  const [progress, setProgress] = useState<UpdateProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<UpdateSummary | null>(null)
  const [ready, setReady] = useState(false)
  const [checking, setChecking] = useState(false)
  const [appVersion, setAppVersion] = useState('')

  /** Read inside the error listener, which must not depend on render timing. */
  const downloading = useRef(false)

  useEffect(() => {
    window.appInfo?.getVersion?.().then((v) => setAppVersion(v ?? ''))
  }, [])

  useEffect(() => {
    // Any surface. The sidebar is where "checking" is reported now, and it is
    // the same sentence whoever asked.
    const offChecking = window.updates.onChecking(() => setChecking(true))

    const offAvailable = window.updates.onAvailable((p) => {
      setChecking(false)
      // Knowing about the update is source-agnostic; acting on it is not.
      setInfo(p.info)
      setReady(false)
      if (p.source !== 'background') return

      // With auto-download on the download runs unannounced, and the user hears
      // about it once, at 'downloaded' - the point where there is actually
      // something for them to decide. The sidebar carries it in the meantime.
      if (p.autoDownload) {
        downloading.current = true
        setPhase('downloading')
        setProgress(null)
        return
      }
      downloading.current = false
      setPhase('available')
      setOpen(true)
    })

    const offProgress = window.updates.onProgress((p) => {
      if (p.source !== 'background') return
      downloading.current = true
      setPhase('downloading')
      setProgress(p)
    })

    const offDownloaded = window.updates.onDownloaded((p) => {
      setChecking(false)
      setInfo(p.info)
      setReady(true)
      if (p.source !== 'background') return
      downloading.current = false
      setPhase('downloaded')
      setOpen(true)
    })

    const offNone = window.updates.onNone(() => {
      setChecking(false)
      // Whoever asked, the answer applies to the whole app: drop the badge.
      setInfo(null)
      setReady(false)
    })

    const offError = window.updates.onError((p) => {
      setChecking(false)
      if (p.source !== 'background') return
      console.log('[Update] background:', p.error)
      // A failed background *check* is not something the user asked for or can
      // act on. A failed *download* is different: they were already told an
      // update was on the way.
      if (!downloading.current) return
      downloading.current = false
      setError(p.error)
      setPhase('error')
      setOpen(true)
    })

    return () =>
      [offChecking, offAvailable, offProgress, offDownloaded, offNone, offError].forEach(
        (off) => off && off()
      )
  }, [])

  const onDownload = async (): Promise<void> => {
    setError(null)
    downloading.current = true
    setPhase('downloading')
    setProgress(null)
    // 'background', not 'settings': this surface owns the flow it starts, so
    // the progress events have to come back to it.
    const r = await window.updates.download('background')
    if (!r.ok) {
      downloading.current = false
      setError(r.error ?? 'Download failed')
      setPhase('error')
    }
  }

  const show = (): void => {
    if (!info) return
    setError(null)
    setPhase(ready ? 'downloaded' : downloading.current ? 'downloading' : 'available')
    setOpen(true)
  }

  return (
    <UpdateContext.Provider
      value={{
        appVersion,
        pending: info ? { version: info.version, ready } : null,
        checking,
        show
      }}
    >
      {children}
      <UpdateDialog
        open={open}
        phase={phase}
        info={info}
        progress={progress}
        error={error}
        appVersion={appVersion}
        onClose={() => setOpen(false)}
        onDownload={onDownload}
        onInstall={() => window.updates.install()}
      />
    </UpdateContext.Provider>
  )
}

export default UpdateProvider
