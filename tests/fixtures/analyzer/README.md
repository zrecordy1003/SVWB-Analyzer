# Analyzer Fixtures

Put stable gameplay screenshots in this directory and declare them in `manifest.json`.

Each case should include:

- `id`: stable test id
- `screenshot`: relative path under this directory
- `description`: optional human context
- `expected`: expected analyzer outputs, such as class, play order, mode, result, BP, or CR

The fixture test harness already validates manifest shape and screenshot paths. Once screenshots are
available, recognition assertions can be added without changing the fixture format.
