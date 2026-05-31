import path from 'path'
import { vi } from 'vitest'

process.env.OPENCV4NODEJS_DISABLE_AUTOBUILD = '1'
process.env.OPENCV_BIN_DIR ??= path.join(process.cwd(), 'resources/opencv/bin')
process.env.OPENCV_INCLUDE_DIR ??= path.join(process.cwd(), 'resources/opencv/include')
process.env.OPENCV_LIB_DIR ??= path.join(process.cwd(), 'resources/opencv/lib')
process.env.PATH = `${process.env.OPENCV_BIN_DIR};${process.env.PATH ?? ''}`

vi.mock('@u4/opencv4nodejs', () => {
  class Rect {
    constructor(
      public x: number,
      public y: number,
      public width: number,
      public height: number
    ) {}
  }

  return {
    default: { Rect },
    Rect,
    Mat: class Mat {}
  }
})
