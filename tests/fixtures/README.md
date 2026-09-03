# Test fixtures

- **`captures/`** — the real screenshots and recordings, one directory per scenario with its
  own README explaining what the frames show. They are asserted against the Rust matcher by
  `tools/vision-node-addon/check-*.cjs` under `pnpm vision:verify`, and replayed frame by frame
  by `pnpm engine:replay`. That path needs the compiled `svwb-vision.node` and the engine
  binary, which is why it runs outside Vitest.

  **New recognition screenshots go here.**

- **`deck-import/`** — captured portal responses, used by the deck-import tests.

## There used to be an `analyzer/` directory

It held a `manifest.json` for a Vitest-side recognition harness, and `cases` was `[]` from the
day it was added to the day it was deleted. `tests/analyzer/fixtures.test.ts` iterated that
empty array, so it asserted nothing — and it had already lost a case that was guarded by
`it.skipIf(cases.length === 0)`, which skipped in exactly the situation where it would have
failed.

Deleted rather than populated. The recognition coverage that exists is thorough and lives in
`tools/engine/tests/fixtures.rs` against `captures/`; a second, empty harness beside it only
suggested coverage that was not there. If a recognition assertion ever genuinely needs to run
inside Vitest, add it then — with a case in it.
