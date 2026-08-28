/**
 * Shared test setup.
 *
 * Previously this mocked `@u4/opencv4nodejs` and pointed several OPENCV_* env
 * vars at `resources/opencv`. Image recognition now lives in a self-contained
 * Rust addon (`tools/svwb-vision.node`), which needs neither - and the tests
 * that used the mock were removed along with the TypeScript pipeline they
 * covered. Their coverage moved into `tools/vision-native/src/lib.rs`.
 *
 * Kept as a file (rather than dropped from vitest.config.ts) because it is the
 * natural home for setup the database-backed tests may need later.
 */
export {}
