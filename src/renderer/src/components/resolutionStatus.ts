/**
 * Whether the game's current window can be recognised, for the sidebar badge.
 *
 * Its own module rather than a helper inside `GameStatus.tsx` so it can be
 * tested without React or MUI: the component around it is presentation, and
 * this is the rule that has twice been wrong about real users' monitors.
 */
export type ResolutionStatus = {
  ok: boolean
  label: string
  width?: number
  height?: number
  hint?: string
}

/**
 * 徽章唯一該回答的問題：「這台機器的畫面能不能辨識」。
 *
 * 每一幀都會先被裁成 16:9 再縮到固定的 1280×720 畫布，所有 ROI 與模板都活在
 * 那個畫布上，所以解析度本身不是條件 —— 條件是**裁切後那塊 16:9 畫面不小於
 * 1280×720**。比它大只是縮得多一點，2560×1440 與 3840×2160 實測與 1920×1080
 * 落在完全相同的座標。
 *
 * 回報的 bounds 是整個視窗（含標題列），而遊戲畫面在螢幕比例不是 16:9 時還會
 * 自己加上黑邊，所以「多出來的高度」可能是標題列、黑邊或兩者。兩種都會被
 * `detect_title_bar_height` 量掉，不需要在這裡分辨；1920×1200 這類 16:10 螢幕
 * 因此同樣可用。詳見 `tools/vision-native/CALIBRATION.md`。
 */
const CANVAS_WIDTH = 1280
const CANVAS_HEIGHT = 720
const CANVAS_ASPECT = CANVAS_WIDTH / CANVAS_HEIGHT

/**
 * 上方那條帶狀區域（標題列 ＋ 黑邊）能被量到的上限，必須跟
 * `vision-native` 的 `MAX_CHROME_ROWS` 一致。超過就量不到，會留在畫面裡把所有
 * ROI 往下推。實務上要 4:3 以上的螢幕又高過 2560 才會碰到。
 */
const MAX_CHROME_ROWS = 320

export const computeResolutionStatus = (bounds?: {
  width?: number
  height?: number
}): ResolutionStatus => {
  const width = bounds?.width
  const height = bounds?.height
  if (!width || !height) return { ok: false, label: '未知', hint: '無法偵測解析度' }

  // 實際會被送去比對的那塊 16:9 畫面：比 16:9 高就是上下有帶狀區域（寬度不變），
  // 比 16:9 寬就是左右留白（高度不變）。
  const tallerThan169 = width / height < CANVAS_ASPECT
  const gameWidth = tallerThan169 ? width : Math.round(height * CANVAS_ASPECT)
  const gameHeight = tallerThan169 ? Math.round(width / CANVAS_ASPECT) : height

  const label =
    gameWidth === width && gameHeight === height
      ? `${width}×${height}`
      : `${width}×${height}（遊戲畫面 ${gameWidth}×${gameHeight}）`

  if (tallerThan169 && height - gameHeight > MAX_CHROME_ROWS) {
    return {
      ok: false,
      label,
      width,
      height,
      hint: '畫面上下的空白過高，辨識會整個位移；建議改用 16:9 解析度'
    }
  }
  if (gameWidth < CANVAS_WIDTH || gameHeight < CANVAS_HEIGHT) {
    return { ok: false, label, width, height, hint: '低於 1280×720，辨識準確度會下降' }
  }

  return { ok: true, label, width, height }
}
