import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';
import importPlugin from 'eslint-plugin-import';

import { sharedImportRules } from '../../eslint.config.mjs';

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    '.next/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
  ]),
  {
    // apps/web is excluded from the root config (eslint-config-next brings its
    // own base), so the import rules are imported from there rather than
    // restated — one definition, two configs.
    //
    // eslint-config-next already registers eslint-plugin-import, but only turns
    // on import/no-anonymous-default-export; re-registering is harmless and
    // makes the dependency explicit here.
    plugins: { import: importPlugin },
    settings: {
      // The five path aliases from tsconfig.json are our own code, not
      // packages — without this they resolve as bare specifiers and land in
      // the `external` group next to react and next.
      'import/internal-regex': '^@(components|features|services|hooks|lib)/',
    },
    rules: sharedImportRules,
  },
]);

export default eslintConfig;
