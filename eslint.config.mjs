import js from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import importPlugin from 'eslint-plugin-import';
import tseslint from 'typescript-eslint';

// Import ordering, shared in intent with apps/web/eslint.config.mjs (which has
// its own config because eslint-config-next brings its own base). Keep the two
// in step: the point is that a file's imports read the same way everywhere.
//
// `@workout-logging/*` is a workspace package, not a third-party one, so it is
// marked internal rather than left to land among the node_modules imports.
export const sharedImportRules = {
  'import/order': [
    'error',
    {
      groups: [
        'builtin', // node: fs, path
        'external', // node_modules
        'internal', // workspace packages and path aliases (see settings below)
        ['parent', 'sibling'], // ../ and ./
        'index', // ./
        'object',
        'type', // `import type { … }` — only module-level type imports, not inline `{ type X }`
      ],
      'newlines-between': 'always',
      alphabetize: { order: 'asc', caseInsensitive: true },
    },
  ],

  // The safety net that makes reordering imports safe to do at all. In ES
  // modules the order of import statements decides evaluation order, so inside
  // a cycle it decides which module sees a half-initialised binding — meaning
  // any code that depends on import order is already fragile, lint or no lint.
  // Forbidding cycles removes the class of problem instead of freezing the
  // order to avoid disturbing it.
  //
  // Turned on from a clean slate: no cycle existed anywhere in the repo when
  // this was added, so it costs nothing today and only stops one appearing.
  //
  // ignoreExternal keeps the traversal inside our own source — cycles between
  // third-party packages are neither our doing nor ours to fix, and walking
  // node_modules is what makes this rule slow. Depth is left at its default of
  // Infinity: passing it explicitly only makes `--print-config` render it as
  // `null`, which reads like a misconfiguration.
  'import/no-cycle': ['error', { ignoreExternal: true }],
};

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      'apps/web/**',
      'infra/terraform/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    plugins: { import: importPlugin },
    settings: {
      // What counts as "internal" for import/order. A regex over the specifier,
      // so the workspace package is grouped with our own code rather than with
      // third-party dependencies.
      'import/internal-regex': '^@workout-logging/',
    },
    rules: sharedImportRules,
  },
);
