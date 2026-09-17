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
  {
    // FR-021: a notification must never discard work in progress, and the
    // logging form is the work in progress the requirement names. It holds the
    // user's half-typed text, date and image previews in local state, which
    // survives any number of re-renders — what would destroy it is the form
    // reacting to the notification store itself, resetting or remounting on a
    // `revision` it has no business reading.
    //
    // Enforced here rather than left to review because it cannot be enforced by
    // a test: apps/web deliberately runs no jsdom (plan.md, the Principle II
    // decision), so "React kept this component's state" is not a property the
    // suite can observe. A lint rule fails CI for the same mistake, and it fails
    // it at the moment the import is written rather than when someone notices
    // their draft vanishing.
    //
    // Only the *subscribing* half is restricted. The form publishes to this
    // same module — `publishWorkoutLogged` after a successful POST is how every
    // list on screen learns a workout exists — and that direction is the whole
    // point of the store. Writing cannot cost the user a draft; reading can.
    //
    // If the form ever genuinely needs to know about a change, the host passes
    // it down as a prop. That way the decision to re-render or reset is made by
    // whoever owns the form's lifetime, not by the form.
    files: ['features/log-workout/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@services/workout-events',
              importNames: ['useWorkoutLog', 'subscribe', 'getSnapshot'],
              message:
                'FR-021: the logging form must not read the notification store — a revision it reads is a draft it can lose. Publishing is fine; to react to a change, take it as a prop from LogWorkoutButton.',
            },
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;
