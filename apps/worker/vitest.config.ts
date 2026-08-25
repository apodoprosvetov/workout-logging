import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: './',
    environment: 'node',
    globals: true,
    include: ['src/**/*.spec.ts', 'tests/**/*.spec.ts'],
  },
});
