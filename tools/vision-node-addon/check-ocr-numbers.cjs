/**
 * Verifies the number windows land on the digits they should read, and that
 * Tesseract returns the expected value from them.
 *
 * This check exists because of a bug it would have caught immediately: the
 * ranked BP window once sat in the empty gap between the 對戰表現獎勵 label and
 * its number. It returned an empty string on every frame, so BP was never
 * recorded for any ranked match - and a misplaced window fails silently, since
 * "unreadable this frame" and "can never read anything" look identical to the
 * caller. Asserting on the decoded VALUE is the point: a window that drifts
 * onto a neighbouring row still reads a number, just the wrong one.
 *
 * The crops come from `svwb-engine crop`, which runs the same
 * `number_window -> shift_roi -> binarize_to_png` path the live engine uses.
 * So this file holds NO window coordinates: it validates the exact pixels the
 * engine sends to OCR in production. (An earlier version mirrored twelve ROIs
 * by hand - the habit that produced the 953-line replay mirror.)
 *
 *   node tools/vision-node-addon/check-ocr-numbers.cjs
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { createWorker, OEM, PSM } = require('tesseract.js')

const ROOT = path.join(__dirname, '..', '..')
const ENGINE = path.join(ROOT, 'tools', 'target', 'release', 'svwb-engine.exe')

const BP_WIN = 'tests/fixtures/captures/ranked-bp-1920-fullscreen/01-result-win-bp.png'
const BP_LOSE = 'tests/fixtures/captures/ranked-bp-1280-windowed-lose/01-result-lose-bp.png'
const MP_LOSE = 'tests/fixtures/captures/ranked-gm-mp-windowed/01-result-lose-mp-cr.png'
const MP_WIN = 'tests/fixtures/captures/ranked-gm-mp-windowed/02-result-win-mp-cr.png'
const MP_WQHD = 'tests/fixtures/captures/ranked-gm-mp-2560-fullscreen/01-result-win-mp-cr.png'
const MP_MASTER = 'tests/fixtures/captures/ranked-master-mp-only/01-result-lose-mp-only.png'

/**
 * `dy` is the result-layout offset for that frame (the reward list's row count
 * slides the whole block; a loss lifts it by 99px against the win layout the
 * windows were measured on). `expectNot` marks a deliberately WRONG read: the
 * unshifted window on the loss frame crops the 階級 row's cumulative BP, which
 * is what shipped before the shift existed - it must never equal the true gain.
 */
const CASES = [
  {
    label: 'ranked BP / TOTAL gained (win)',
    file: BP_WIN,
    window: 'bpRanked',
    dy: 0,
    expect: '+124'
  },
  {
    label: 'ranked BP / TOTAL gained (lose, shifted)',
    file: BP_LOSE,
    window: 'bpRanked',
    dy: -99,
    expect: '+8'
  },
  {
    label: 'ranked BP unshifted on the lose layout',
    file: BP_LOSE,
    window: 'bpRanked',
    dy: 0,
    expectNot: '+8'
  },
  {
    label: 'MP layout / gained MP (lose)',
    file: MP_LOSE,
    window: 'gainedMp',
    dy: 0,
    expect: '+15'
  },
  {
    label: 'MP layout / total MP (lose)',
    file: MP_LOSE,
    window: 'totalMp',
    dy: 0,
    expect: '41743'
  },
  { label: 'MP layout / delta CR (lose)', file: MP_LOSE, window: 'deltaCr', dy: 0, expect: '-16' },
  { label: 'MP layout / total CR (lose)', file: MP_LOSE, window: 'totalCr', dy: 0, expect: '1557' },
  { label: 'MP layout / gained MP (win)', file: MP_WIN, window: 'gainedMp', dy: 0, expect: '+173' },
  { label: 'MP layout / total MP (win)', file: MP_WIN, window: 'totalMp', dy: 0, expect: '41938' },
  { label: 'MP layout / delta CR (win)', file: MP_WIN, window: 'deltaCr', dy: 0, expect: '+14' },
  { label: 'MP layout / total CR (win)', file: MP_WIN, window: 'totalCr', dy: 0, expect: '1538' },
  // 2560x1440, and a client that draws 「指定系列」 under the MP bar. The MP half
  // of the panel is lifted 19px by that row while the CR half stays put, so the
  // two halves take DIFFERENT offsets - which is why the MP windows are anchored
  // to 「獲得MP」 and not to the score-system label. The `expectNot` pair is the
  // shipped-before behaviour: one offset for the whole panel read the gap above
  // the label and the tail of the row above the total.
  {
    label: 'MP layout / gained MP (2560, MP block shifted)',
    file: MP_WQHD,
    window: 'gainedMp',
    dy: -19,
    expect: '+173'
  },
  {
    label: 'MP layout / total MP (2560, MP block shifted)',
    file: MP_WQHD,
    window: 'totalMp',
    dy: -19,
    expect: '24592'
  },
  {
    label: 'Master MP-only / gained MP',
    file: MP_MASTER,
    window: 'gainedMp',
    dy: -20,
    expect: '+14'
  },
  {
    label: 'Master MP-only / total MP',
    file: MP_MASTER,
    window: 'totalMp',
    dy: -20,
    expect: '16867'
  },
  {
    label: 'MP layout / gained MP at the CR offset (2560)',
    file: MP_WQHD,
    window: 'gainedMp',
    dy: -2,
    expectNot: '+173'
  },
  {
    label: 'MP layout / total MP at the CR offset (2560)',
    file: MP_WQHD,
    window: 'totalMp',
    dy: -2,
    expectNot: '24592'
  },
  {
    label: 'MP layout / delta CR (2560)',
    file: MP_WQHD,
    window: 'deltaCr',
    dy: -2,
    expect: '+13'
  },
  {
    label: 'MP layout / total CR (2560)',
    file: MP_WQHD,
    window: 'totalCr',
    dy: -2,
    expect: '1482'
  }
]

/**
 * Canonicalise Tesseract's output for string comparison - full-width signs,
 * letter O for zero, stray whitespace. The engine's `parse_signed_int` is the
 * authoritative version of this; the copy here exists only because the
 * expectations are strings and covers nothing the Rust tests do not.
 */
function normalize(text) {
  return (text ?? '')
    .replace(/[＋﹢]/g, '+')
    .replace(/[－﹣]/g, '-')
    .replace(/[Oo]/g, '0')
    .replace(/\s+/g, '')
}

async function main() {
  if (!fs.existsSync(ENGINE)) {
    console.error(
      `FAIL: ${path.relative(ROOT, ENGINE)} not built - run:\n` +
        '  cargo build --manifest-path tools/Cargo.toml -p svwb-engine --release'
    )
    process.exit(1)
  }

  const worker = await createWorker(['eng'], OEM.DEFAULT, { langPath: ROOT })
  await worker.setParameters({
    tessedit_char_whitelist: '+-0123456789',
    tessedit_pageseg_mode: PSM.SINGLE_LINE
  })

  let failures = 0
  try {
    for (const c of CASES) {
      const png = execFileSync(
        ENGINE,
        ['crop', '--image', path.join(ROOT, c.file), '--window', c.window, '--dy', String(c.dy)],
        { maxBuffer: 4 * 1024 * 1024 }
      )
      const {
        data: { text }
      } = await worker.recognize(png)
      const got = normalize(text)

      if (c.expectNot !== undefined) {
        if (got === c.expectNot) {
          failures++
          console.error(`FAIL ${c.label}: expected anything but ${JSON.stringify(got)}`)
        } else {
          console.log(`ok   ${c.label} -> ${JSON.stringify(got)}`)
        }
      } else if (got === c.expect) {
        console.log(`ok   ${c.label} -> ${got}`)
      } else {
        failures++
        console.error(
          `FAIL ${c.label}: expected ${JSON.stringify(c.expect)}, got ${JSON.stringify(got)}` +
            (got === '' ? '  (empty: the window is probably off the number)' : '')
        )
      }
    }
  } finally {
    await worker.terminate()
  }

  if (failures > 0) {
    console.error(`\n${failures} OCR window check(s) failed`)
    process.exitCode = 1
  } else {
    console.log(
      `\nall ${CASES.length} OCR windows read their expected value via the engine's crops`
    )
  }
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
