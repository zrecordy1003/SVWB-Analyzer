// main/smart-close.ts
import { BrowserWindow, app } from 'electron'
import Store from 'electron-store'
import { openExitOrMinimizeDialog } from './exitChoiceDialog.js'

export type ShouldAskExitFn = () => boolean
export type ExitConfirmFn = () => Promise<boolean>

type ClosePref = 'minimize' | 'exit'
type SmartCloseOptions = {
  shouldAskExit: ShouldAskExitFn
  confirmExit: ExitConfirmFn
  onBeforeMinimize?: () => void
  onBeforeExitApproved?: () => void
}

const store = new Store<{ settings: { onCloseBehavior: ClosePref } }>()

export function attachSmartClose(
  win: BrowserWindow,
  opts: SmartCloseOptions
): { requestExit: () => Promise<void> } {
  let isQuitting = false
  app.on('before-quit', () => {
    isQuitting = true
  })

  win.on('close', async (e) => {
    if (isQuitting) return
    e.preventDefault()

    const pref = store.get('settings.onCloseBehavior')
    let action: ClosePref = pref

    if (store.get('settings.askBeforeExit') === true) {
      const { action: chosen, remember } = await openExitOrMinimizeDialog({
        parent: win,
        appName: 'SVWB Analyzer',
        title: '要關閉還是最小化到系統列？',
        message: '你想要最小化到系統列（背景執行）還是關閉應用？',
        detail: '最小化後仍可於背景運行；關閉將停止擷取與背景作業。',
        rememberLabel: '記住我的選擇',
        defaultAction: 'minimize'
      })
      if (chosen === 'cancel') return
      action = chosen
      if (remember) {
        store.set('settings.onCloseBehavior', action)
        store.set('settings.askBeforeExit', false)
      }
    }

    if (action === 'minimize') {
      opts.onBeforeMinimize?.()
      win.hide()
      return
    }

    const ok = await runExitSequence(opts)
    if (ok) {
      isQuitting = true
      win.destroy()
    }
  })

  const requestExit = async (): Promise<void> => {
    if (win.isDestroyed()) return
    const ok = await runExitSequence(opts)
    if (ok) {
      isQuitting = true
      win.destroy()
    }
  }
  return { requestExit }
}

async function runExitSequence(opts: SmartCloseOptions): Promise<boolean> {
  const needAsk = opts.shouldAskExit()
  if (!needAsk) {
    opts.onBeforeExitApproved?.()
    return true
  }
  const approved = await opts.confirmExit()
  if (approved) {
    opts.onBeforeExitApproved?.()
    return true
  }
  return false
}
