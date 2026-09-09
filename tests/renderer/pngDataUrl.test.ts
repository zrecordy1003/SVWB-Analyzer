import { describe, expect, it } from 'vitest'

import { toPngDataUrl } from '@renderer/utils/pngDataUrl'

/**
 * The one thing `toPngDataUrl` has to get right is that the bytes survive.
 *
 * It exists because `Match.oppo_name_crop` arrives as a `Uint8Array` and an
 * `<img src>` needs a string, and it is written as a chunked loop rather than
 * one `String.fromCharCode(...bytes)` call - which is the part worth a test,
 * because the loop only differs from the naive version on inputs longer than a
 * nameplate will ever be, so nothing in the app would ever exercise it.
 */
describe('toPngDataUrl', () => {
  const decode = (url: string): number[] => {
    const base64 = url.replace(/^data:image\/png;base64,/, '')
    return Array.from(Buffer.from(base64, 'base64'))
  }

  it('keeps every byte, including NUL and 0xff', () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x7f])
    const url = toPngDataUrl(bytes)

    expect(url.startsWith('data:image/png;base64,')).toBe(true)
    expect(decode(url)).toEqual(Array.from(bytes))
  })

  /**
   * Longer than one 0x8000 chunk, so the loop runs more than once and a wrong
   * boundary shows up as a corrupted or truncated tail. A nameplate is ~1.5 KB,
   * so only a test ever comes near this.
   */
  it('joins its chunks in order', () => {
    const bytes = new Uint8Array(0x8000 * 2 + 17)
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256

    expect(decode(toPngDataUrl(bytes))).toEqual(Array.from(bytes))
  })

  it('an empty input is a valid, empty data URL', () => {
    expect(toPngDataUrl(new Uint8Array())).toBe('data:image/png;base64,')
  })
})
