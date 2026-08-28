// Exercises the diagnostics store's throttling, frame cap and log rotation.
//
// These are the parts that could quietly misbehave in the field: a missing
// throttle would write two rows a second, and a broken cap would grow without
// bound on a user's disk. All of it is pure bookkeeping, so it can be driven
// hard here rather than discovered later.
//
// src/main/recognition/diagnosticsRecorder.ts deliberately imports nothing but fs and path, so it
// can be transpiled on its own and exercised outside Electron.
//
//   node tools/vision-node-addon/check-diagnostics.cjs
const fs = require('fs')
const os = require('os')
const path = require('path')
const { pathToFileURL } = require('url')

const { transpileToMjs, cleanupTranspiled } = require('./transpile.cjs')

async function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'svwb-diag-'))
  const dir = path.join(work, 'store')
  fs.mkdirSync(dir)

  let diag
  try {
    diag = await import(
      pathToFileURL(transpileToMjs('src/main/recognition/diagnosticsRecorder.ts', work)).href
    )
  } catch (e) {
    console.error('cannot transpile/import src/main/recognition/diagnosticsRecorder.ts:')
    console.error(e.stdout?.toString() || e.message)
    process.exit(1)
  }

  let failures = 0
  const check = (label, ok, detail = '') => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`)
    if (!ok) failures++
  }

  const eventsFile = path.join(dir, 'events.jsonl')
  const framesDir = path.join(dir, 'frames')
  const events = () =>
    fs.existsSync(eventsFile)
      ? fs
          .readFileSync(eventsFile, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : []
  diag.configureDiagnostics({ dir, enabled: true, appVersion: 'test', platform: 'test' })

  console.log('event throttling')
  for (let i = 0; i < 200; i++) diag.noteEvent('mode-guessed', 'ranked', { i })
  check('200 identical events collapse to 1', events().length === 1, `got ${events().length}`)
  diag.noteEvent('mode-guessed', 'twoPick', {})
  check(
    'throttle is per (kind,label), not per kind',
    events().length === 2,
    `got ${events().length}`
  )

  console.log('\nframe sidecars')
  // Frame WRITING - the 30s throttle and the 20-file cap - moved into the engine
  // with the pixels it needs, and is covered by
  // `tools/engine/src/diagnostics.rs::tests`. What remains here is the half this
  // module still owns: the sidecar written beside a frame the engine saved.
  fs.mkdirSync(framesDir, { recursive: true })
  const savedFrame = '000001700000000_ocr-reject.png'
  fs.writeFileSync(path.join(framesDir, savedFrame), Buffer.alloc(16))
  diag.noteFromEngine('ocr-reject', 'gainedMP', { frame: savedFrame, rawText: '??' })
  const sidecarPath = path.join(framesDir, savedFrame.replace('.png', '.json'))
  check('a saved frame gets a sidecar', fs.existsSync(sidecarPath))
  const sidecar = fs.existsSync(sidecarPath) ? JSON.parse(fs.readFileSync(sidecarPath, 'utf8')) : {}
  check('the sidecar carries the detail', sidecar.rawText === '??', `got ${sidecar.rawText}`)
  check('the sidecar names its frame', sidecar.frame === savedFrame)

  const withoutFrame = events().length
  diag.noteFromEngine('mode-corrected', 'custom->ranked', {})
  check(
    'a kind with no frame still produces an event',
    events().length === withoutFrame + 1,
    `got ${events().length - withoutFrame}`
  )

  console.log('\nnear-miss aggregation')
  const before = events().length
  for (let i = 0; i < 100; i++) diag.noteScore('classes', 0.65, 0.7) // inside the band
  for (let i = 0; i < 100; i++) diag.noteScore('classes', 0.95, 0.7) // cleared, ignore
  for (let i = 0; i < 100; i++) diag.noteScore('classes', 0.2, 0.7) // far below, ignore
  check(
    'counted, not written per observation',
    events().length === before,
    `${events().length - before} rows appeared early`
  )
  diag.flushDiagnostics()
  const agg = events().find((r) => r.kind === 'near-miss')
  check('one summary row after flush', !!agg)
  check('only in-band observations counted', agg?.count === 100, `count=${agg?.count}`)
  check('records the worst score seen', agg?.worst === 0.65, `worst=${agg?.worst}`)

  console.log('\nslow ticks (higher is worse)')
  diag.noteSlowTick(700, 500)
  diag.noteSlowTick(1500, 500)
  diag.noteSlowTick(600, 500)
  diag.flushDiagnostics()
  const tick = events().find((r) => r.kind === 'tick-over-budget')
  check('worst is the largest overshoot', tick?.worst === 1500, `worst=${tick?.worst}`)

  console.log('\nlog rotation')
  for (let i = 0; i < 6000; i++) {
    diag.noteEvent('mode-unattributable', `pad-${i}`, { filler: 'x'.repeat(120) })
  }
  check('rolled to events.previous.jsonl', fs.existsSync(path.join(dir, 'events.previous.jsonl')))
  check(
    'current log stayed bounded',
    fs.statSync(eventsFile).size < 1024 * 1024,
    `${(fs.statSync(eventsFile).size / 1024).toFixed(0)}KB`
  )

  console.log('\ndisabled mode')
  const off = path.join(work, 'off')
  fs.mkdirSync(off)
  diag.configureDiagnostics({ dir: off, enabled: false, appVersion: 'test', platform: 'test' })
  diag.noteEvent('mode-guessed', 'x', {})
  diag.noteFromEngine('ocr-reject', 'x', { frame: 'anything.png' })
  diag.noteScore('x', 0.65, 0.7)
  diag.noteSlowTick(9999, 500)
  diag.flushDiagnostics()
  check(
    'nothing is created when disabled',
    fs.readdirSync(off).length === 0,
    fs.readdirSync(off).join(', ') || 'empty'
  )

  fs.rmSync(work, { recursive: true, force: true })
  cleanupTranspiled()
  console.log(
    failures === 0 ? '\nall diagnostics bookkeeping checks passed' : `\n${failures} check(s) failed`
  )
  process.exitCode = failures ? 1 : 0
}

main()
