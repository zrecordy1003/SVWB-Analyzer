/**
 * Build-time variables the main process reads (`import.meta.env`).
 *
 * electron-vite exposes any `MAIN_VITE_*` variable from the environment or a
 * `.env` file to the main bundle and replaces it with a literal when it builds,
 * so these are not read at run time and are not in the repository. See
 * `src/main/sync/config.ts` for what they are.
 */
interface ImportMetaEnv {
  readonly MAIN_VITE_GOOGLE_CLIENT_ID?: string
  readonly MAIN_VITE_GOOGLE_CLIENT_SECRET?: string
}
