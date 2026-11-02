import React, { lazy } from 'react'

/**
 * `React.lazy` 加上一個可以提早呼叫的 `preload`。
 *
 * 單純的 `lazy` 就算程式碼區塊早就抓好了，第一次 render 還是會 suspend 一次：
 * 它只認自己呼叫 factory 拿到的那個 promise，不會同步讀已經 resolve 的值。
 * 結果就是「明明預載過，第一次切過去還是閃一下轉圈」。這裡在 `preload` 完成時
 * 把元件本身記下來，之後直接 render 它，完全跳過 Suspense。
 */
export type PreloadableComponent = React.FC & { preload: () => Promise<unknown> }

export function preloadableLazy(
  load: () => Promise<{ default: React.ComponentType }>
): PreloadableComponent {
  let loaded: React.ComponentType | null = null
  let pending: Promise<{ default: React.ComponentType }> | null = null
  const preload = (): Promise<{ default: React.ComponentType }> => {
    pending ??= load().then((mod) => {
      loaded = mod.default
      return mod
    })
    return pending
  }
  const Lazy = lazy(preload)
  const Component = (): React.JSX.Element =>
    loaded ? React.createElement(loaded) : React.createElement(Lazy)
  return Object.assign(Component, { preload })
}
