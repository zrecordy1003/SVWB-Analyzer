/**
 * Settings → 資料管理 → 清除資料, in the real app.
 *
 * The unit tests (`tests/main/dataClear.test.ts`) cover what a clear does to the
 * database. This is the part they cannot: the dialog in front of it - that the
 * counts shown are the real ones, that matches are ticked and the rest are not,
 * that nothing happens until the confirm button, and that the result says what
 * was removed.
 */
import { test, expect } from './app'
import type { Page } from '@playwright/test'

async function invoke<T>(window: Page, channel: string, ...args: unknown[]): Promise<T> {
  return window.evaluate(
    ([ch, a]) =>
      (
        window as unknown as {
          electron: { ipcRenderer: { invoke: (c: string, ...x: unknown[]) => Promise<unknown> } }
        }
      ).electron.ipcRenderer.invoke(ch as string, ...(a as unknown[])) as Promise<T>,
    [channel, args] as const
  )
}

test('the dialog shows how many of each there are, clears only what is ticked, and says what it did', async ({
  window
}) => {
  for (let i = 0; i < 3; i++) {
    await invoke(window, 'matches:create', {
      my_class: 'witch',
      oppo_class: 'bishop',
      play_order: 'first',
      result: true,
      note: `m${i}`
    })
  }
  await invoke(window, 'tags:create', '練習')

  await window.getByRole('button', { name: '設定', exact: true }).click()
  await window.getByRole('button', { name: '清除資料⋯' }).click()
  const dialog = window.getByRole('dialog')

  // Each kind with its number; matches ticked by default, nothing else.
  await expect(dialog.getByText('3 場')).toBeVisible()
  await expect(dialog.getByText('1 個').first()).toBeVisible()
  await expect(dialog.getByRole('checkbox', { name: /對局資料/ })).toBeChecked()
  await expect(dialog.getByRole('checkbox', { name: /標籤/ })).not.toBeChecked()
  // A kind with none cannot be ticked.
  await expect(dialog.getByRole('checkbox', { name: /牌組分類/ })).toBeDisabled()

  await dialog.getByRole('button', { name: '清除', exact: true }).click()
  await expect(dialog.getByText(/已清除：對局資料 3 場/)).toBeVisible()
  await dialog.getByRole('button', { name: '完成' }).click()

  // The matches are gone; the tag, which was not ticked, is not.
  expect(await invoke<unknown[]>(window, 'matches:getPage', {})).toHaveLength(0)
  expect(await invoke<unknown[]>(window, 'tags:list')).toHaveLength(1)
})

test('cancelling removes nothing', async ({ window }) => {
  await invoke(window, 'matches:create', {
    my_class: 'witch',
    oppo_class: 'bishop',
    play_order: 'first',
    result: true
  })
  await window.getByRole('button', { name: '設定', exact: true }).click()
  await window.getByRole('button', { name: '清除資料⋯' }).click()
  await window.getByRole('dialog').getByRole('button', { name: '取消' }).click()
  expect(await invoke<unknown[]>(window, 'matches:getPage', {})).toHaveLength(1)
})
