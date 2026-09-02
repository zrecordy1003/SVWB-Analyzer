import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'

export default tseslint.config(
  // `.wrangler` is the local state and bundle output of `wrangler dev` under
  // server/telemetry; generated, and not ours to lint.
  { ignores: ['**/node_modules', '**/dist', '**/out', '**/.wrangler'] },
  tseslint.configs.recommended,
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat['jsx-runtime'],
  {
    settings: {
      react: {
        version: 'detect'
      }
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': eslintPluginReactHooks,
      'react-refresh': eslintPluginReactRefresh
    },
    rules: {
      ...eslintPluginReactHooks.configs.recommended.rules,
      ...eslintPluginReactRefresh.configs.vite.rules,
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          varsIgnorePattern: '^_',
          argsIgnorePattern: '^_'
        }
      ],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': 'off'
    }
  },
  {
    // Playwright names a fixture's teardown boundary `use`, so every fixture
    // reads as a call to a React hook from a non-component function. There are
    // no React components in the e2e harness at all - it drives the built app
    // from the outside - so the hooks rules have nothing to say here.
    files: ['tests/e2e/**/*.ts'],
    rules: {
      'react-hooks/rules-of-hooks': 'off'
    }
  },
  {
    // Standalone diagnostic scripts under tools/ are plain CommonJS: they load
    // the native .node addon directly, which require() is the only way to do
    // while the app itself is ESM. They are not part of the shipped bundle, so
    // the TypeScript-oriented app rules do not apply.
    files: ['tools/**/*.cjs', 'tools/**/*.mjs'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off'
    }
  },
  {
    // server/telemetry/smoke.mjs drives a running Worker over HTTP. It is plain
    // node, run by hand and never bundled, so the return-type rule the app code
    // wants buys nothing here.
    files: ['server/**/*.mjs'],
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off'
    }
  },
  eslintConfigPrettier
)
