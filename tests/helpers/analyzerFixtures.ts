import fs from 'fs'
import path from 'path'

export type AnalyzerFixtureExpected = {
  myClass?: string
  opponentClass?: string
  playOrder?: string
  mode?: string
  result?: boolean
  bp?: number
  currentCr?: number
  deltaCr?: number
}

export type AnalyzerFixtureCase = {
  id: string
  screenshot: string
  description?: string
  expected: AnalyzerFixtureExpected
}

export type AnalyzerFixtureManifest = {
  version: 1
  cases: AnalyzerFixtureCase[]
}

export const analyzerFixtureDir = path.join(process.cwd(), 'tests', 'fixtures', 'analyzer')
export const analyzerFixtureManifestPath = path.join(analyzerFixtureDir, 'manifest.json')

export function loadAnalyzerFixtureManifest(): AnalyzerFixtureManifest {
  const raw = fs.readFileSync(analyzerFixtureManifestPath, 'utf8')
  return JSON.parse(raw) as AnalyzerFixtureManifest
}

export function resolveFixtureScreenshot(fixture: AnalyzerFixtureCase): string {
  const resolved = path.resolve(analyzerFixtureDir, fixture.screenshot)
  const fixtureRoot = path.resolve(analyzerFixtureDir)
  if (!resolved.startsWith(fixtureRoot + path.sep)) {
    throw new Error(`Fixture screenshot escapes fixture dir: ${fixture.id}`)
  }
  return resolved
}
