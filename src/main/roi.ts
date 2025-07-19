// roi.ts

// 基準解析度
const BW = 1280,
  BH = 720

interface ROI {
  x: number
  y: number
  width: number
  height: number
}

export const scale = (v: number, base: number, cur: number): number => Math.round((v / base) * cur)

export const getRoleLeft = (w: number, h: number): ROI => ({
  x: scale(50, BW, w),
  y: scale(480, BH, h),
  width: scale(180, BW, w),
  height: scale(180, BH, h)
})

export const getRoleRight = (w: number, h: number): ROI => ({
  x: scale(1690, BW, w),
  y: scale(480, BH, h),
  width: scale(180, BW, w),
  height: scale(180, BH, h)
})

export const getFirstSecondROI = (w: number, h: number): ROI => ({
  x: scale(760, BW, w),
  y: scale(500, BH, h),
  width: scale(400, BW, w),
  height: scale(220, BH, h)
})
