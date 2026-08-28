# Analyzer Fixtures

Put stable gameplay screenshots in this directory and declare them in `manifest.json`.

Each case should include:

- `id`: stable test id
- `screenshot`: relative path under this directory
- `description`: optional human context
- `expected`: expected analyzer outputs, such as class, play order, mode, result, BP, or CR

The fixture test harness already validates manifest shape and screenshot paths. Once screenshots are
available, recognition assertions can be added without changing the fixture format.

## Which fixture directory to use

Both live under `tests/fixtures/` now (they used to be split across `test/` and
`tests/`, one letter apart, which was a trap):

- **`tests/fixtures/captures/`** holds the real captures — ten screenshots across three
  scenarios, plus a recording. They are asserted against the Rust matcher by
  `tools/vision-node-addon/check-*.cjs` under `pnpm vision:verify`, and replayed frame by
  frame by `pnpm vision:replay-cpu`. That path needs the compiled `svwb-vision.node`,
  which is why it runs outside Vitest.
- **`tests/fixtures/analyzer/`** (here) is the Vitest-side manifest. `manifest.json` is
  still empty, so nothing in it is exercised yet.

Add new screenshots to `tests/fixtures/captures/` unless you specifically need them
inside a Vitest run.
