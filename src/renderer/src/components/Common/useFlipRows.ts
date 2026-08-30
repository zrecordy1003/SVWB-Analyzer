import { useCallback, useLayoutEffect, useRef } from 'react'

/**
 * 重新排序時讓每一列從舊位置滑到新位置（FLIP）。
 *
 * 換一次篩選條件，七列的順序可能整個翻掉。沒有這段過渡的話畫面是「一瞬間換
 * 成另一張表」，人得重新從頭找自己剛剛在看的那一列；讓列自己滑過去，眼睛就
 * 跟得住 - 過渡在這裡是為了維持連續性，不是裝飾。
 *
 * 做法是先量新舊位置的差，先用 transform 把列釘回舊位置，再放掉讓它滑到新的
 * 位置。整段只動 transform，不碰版面，所以不會有重排成本。
 */
export function useFlipRows(order: readonly string[]): (key: string) => (node: any) => void {
  const nodes = useRef(new Map<string, HTMLElement>())
  const previousTops = useRef(new Map<string, number>())

  const signature = order.join('|')

  useLayoutEffect(() => {
    const nextTops = new Map<string, number>()
    nodes.current.forEach((node, key) => nextTops.set(key, node.offsetTop))

    const reduceMotion =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches

    if (!reduceMotion) {
      nextTops.forEach((top, key) => {
        const previous = previousTops.current.get(key)
        const node = nodes.current.get(key)
        // 第一次看到這一列（初次載入、剛出現）就不要滑：它沒有「舊位置」。
        if (previous === undefined || !node) return
        const delta = previous - top
        if (delta === 0) return

        node.style.transition = 'none'
        node.style.transform = `translateY(${delta}px)`
        requestAnimationFrame(() => {
          node.style.transition = 'transform .32s cubic-bezier(.2,.8,.2,1)'
          node.style.transform = ''
        })
      })
    }

    previousTops.current = nextTops
  }, [signature])

  return useCallback(
    (key: string) => (node: any) => {
      if (node) nodes.current.set(key, node as HTMLElement)
      else nodes.current.delete(key)
    },
    []
  )
}

export default useFlipRows
