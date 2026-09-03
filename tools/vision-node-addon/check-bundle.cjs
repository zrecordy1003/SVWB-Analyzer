// Verifies the exported diagnostics zip is actually well-formed.
//
// The export is the one path a struggling user has to reach the developer, so a
// silently broken zip would be the worst place to have a bug. src/main/
// diagnosticsBundle.ts imports no Electron, so it can be driven directly here.
//
//   node tools/vision-node-addon/check-bundle.cjs
const fs = require('fs')
const os = require('os')
const path = require('path')
const { pathToFileURL } = require('url')

const { transpileToMjs, cleanupTranspiled, ROOT } = require('./transpile.cjs')

async function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'svwb-bundle-'))
  const store = path.join(work, 'store')
  const frames = path.join(store, 'frames')
  fs.mkdirSync(frames, { recursive: true })

  let mod
  try {
    mod = await import(
      pathToFileURL(transpileToMjs('src/main/recognition/diagnosticsBundle.ts', work)).href
    )
  } catch (e) {
    console.error('cannot transpile/import src/main/recognition/diagnosticsBundle.ts:')
    console.error(e.stdout?.toString() || e.message)
    process.exit(1)
  }

  let failures = 0
  const check = (label, ok, detail = '') => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`)
    if (!ok) failures++
  }

  const env = {
    appVersion: '9.9.9',
    platform: 'win32',
    osRelease: '10.0.99999',
    logicalCores: 8
  }

  console.log('empty store')
  check('nothing to export yields null', (await mod.buildBundle(store, env)) === null)
  const empty = mod.summarise(store)
  check(
    'summary reports zero',
    empty.eventCount === 0 && empty.frameCount === 0 && empty.logBytes === 0
  )

  console.log('\nseeded store')
  fs.writeFileSync(
    path.join(store, 'events.jsonl'),
    [
      JSON.stringify({
        at: '2026-08-26T10:00:00.000Z',
        kind: 'near-miss',
        label: 'result',
        count: 12,
        worst: 0.63
      }),
      JSON.stringify({ at: '2026-08-26T10:05:00.000Z', kind: 'mode-unattributable', label: 'win' }),
      // A truncated final line, as happens if the app is killed mid-write.
      '{"at":"2026-08-26T10:06'
    ].join('\n') + '\n'
  )
  // A real PNG header so the bytes are not trivially compressible.
  fs.writeFileSync(
    path.join(frames, '2026-08-26T10-05-00-000Z_mode-unattributable.png'),
    Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(4096, 0x5a)])
  )
  fs.writeFileSync(
    path.join(frames, '2026-08-26T10-05-00-000Z_mode-unattributable.json'),
    JSON.stringify({ kind: 'mode-unattributable', resultScore: 0.9 })
  )

  const summary = mod.summarise(store)
  check(
    'malformed line skipped, valid ones kept',
    summary.eventCount === 2,
    `got ${summary.eventCount}`
  )
  check('frame counted', summary.frameCount === 1, `got ${summary.frameCount}`)
  check('byte total is non-zero', summary.bytes > 4096, `${summary.bytes} bytes`)
  check(
    'latest timestamp is the newest event',
    summary.latestAt === '2026-08-26T10:05:00.000Z',
    String(summary.latestAt)
  )

  const buffer = await mod.buildBundle(store, env)
  check('bundle produced', Buffer.isBuffer(buffer) && buffer.length > 0, `${buffer?.length} bytes`)
  check('starts with the zip magic number', buffer.subarray(0, 2).toString() === 'PK')

  // Read it back with a fresh JSZip to prove it is genuinely parseable.
  const JSZip = require(path.join(ROOT, 'node_modules', 'jszip'))
  const round = await JSZip.loadAsync(buffer)
  const names = Object.keys(round.files)
    .filter((n) => !round.files[n].dir)
    .sort()
  check(
    'contains report.md, report.json and the frame files',
    names.includes('report.md') &&
      names.includes('report.json') &&
      names.some((n) => n.endsWith('.png')) &&
      names.some((n) => n.startsWith('frames/') && n.endsWith('.json')),
    names.join(', ')
  )

  const md = await round.file('report.md').async('string')
  check('report.md names the app version', md.includes('9.9.9'))
  check('report.md names the core count', md.includes('| 8 |'))
  check(
    'report.md explains the important kind',
    md.includes('mode-unattributable') && md.includes('最需要關注')
  )
  check('report.md lists recent events as json', md.includes('```json'))

  const reportJson = JSON.parse(await round.file('report.json').async('string'))
  check('report.json carries the parsed events', reportJson.events.length === 2)
  check('report.json carries the environment', reportJson.logicalCores === 8)

  const png = await round
    .file('frames/2026-08-26T10-05-00-000Z_mode-unattributable.png')
    .async('nodebuffer')
  check('frame bytes survive the round trip', png.length === 4100, `${png.length} bytes`)

  // The case the export used to refuse, and the reason it now does not. A user
  // whose engine never starts has no anomalies and no frames - recognition
  // never ran, so it never doubted anything - and the startup log is the only
  // thing that can explain it. They were shown "沒有可匯出的紀錄" instead.
  console.log('\nlog-only store')
  const logStore = path.join(work, 'log-only')
  fs.mkdirSync(path.join(logStore, 'frames'), { recursive: true })
  fs.writeFileSync(
    path.join(logStore, 'engine.log'),
    [
      '2026-09-03T01:00:00.000Z [Startup] version=9.9.9 arch=x64 platform=win32 packaged=true',
      '2026-09-03T01:00:00.001Z [Engine] spawned pid=4242',
      '2026-09-03T01:00:00.500Z [Engine] cannot start capture: attach failed',
      '2026-09-03T01:00:00.600Z [Engine] exited code=1 signal=none reachedReady=false'
    ].join('\n') + '\n'
  )

  const logOnly = mod.summarise(logStore)
  check('log bytes reported', logOnly.logBytes > 0, `${logOnly.logBytes} bytes`)
  check('no anomalies beside it', logOnly.eventCount === 0 && logOnly.frameCount === 0)

  const logBundle = await mod.buildBundle(logStore, env)
  check(
    'a log alone is still exportable',
    Buffer.isBuffer(logBundle) && logBundle.length > 0,
    `${logBundle?.length} bytes`
  )
  const logRound = await JSZip.loadAsync(logBundle)
  check('zip carries engine.log', Object.keys(logRound.files).includes('engine.log'))
  check(
    'log content survives the round trip',
    (await logRound.file('engine.log').async('string')).includes('cannot start capture')
  )
  const logMd = await logRound.file('report.md').async('string')
  check('report.md points at the startup log', logMd.includes('引擎啟動記錄'))
  check(
    'report.md says an empty report is not a healthy one',
    logMd.includes('引擎從未產出任何辨識結果')
  )

  console.log('\nclearStore')
  mod.clearStore(store)
  const cleared = mod.summarise(store)
  check('store is emptied', cleared.eventCount === 0 && cleared.frameCount === 0)
  check('frames dir is recreated, not left missing', fs.existsSync(frames))
  mod.clearStore(logStore)
  check('the log is cleared too', mod.summarise(logStore).logBytes === 0)

  fs.rmSync(work, { recursive: true, force: true })
  cleanupTranspiled()
  console.log(failures === 0 ? '\nexport bundle is well-formed' : `\n${failures} check(s) failed`)
  process.exitCode = failures ? 1 : 0
}

main()
