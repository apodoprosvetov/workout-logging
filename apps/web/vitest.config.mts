// `.mts`, unlike apps/api's and apps/worker's plain `.ts` configs: this package
// has no `"type": "module"` (and must not get one — it is a Next app), so a
// `.ts` config is loaded as CJS, and `vite-tsconfig-paths` v6 is ESM-only.
// Loading it that way fails with 'resolved to an ESM file. ESM file cannot be
// loaded by `require`'. The `.mts` extension forces ESM for this one file
// without changing how anything else in apps/web is treated.
import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  test: {
    root: './',
    // `node`, not `jsdom`: this suite covers pure logic only — SSE frame
    // parsing, reconnect backoff, week relevance (specs/004 plan.md, the
    // Principle II gate decision). Component rendering and hooks are verified
    // by quickstart.md scenarios instead, so nothing here needs a DOM.
    environment: 'node',
    globals: true,
    include: ['**/*.spec.ts'],
    // Next's build output and deps would otherwise be walked by the glob above.
    exclude: ['node_modules/**', '.next/**'],
  },
  // apps/web modules import each other through the tsconfig path aliases
  // (`@lib/workouts`, `@services/...`), so a test that imports a module under
  // test fails to resolve without this — the module's *own* imports are what
  // break, even when the test itself uses a relative path.
  //
  // Reading the aliases from tsconfig.json rather than restating them here
  // keeps one definition of the mapping: a new alias added to tsconfig works in
  // tests with no change to this file.
  plugins: [tsconfigPaths()],
});
