import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: './',
    environment: 'node',
    globals: true,
    include: ['src/**/*.spec.ts', 'tests/**/*.spec.ts'],
  },
  // NestJS's constructor-based DI needs `emitDecoratorMetadata`, which
  // Vitest's default esbuild transform doesn't emit — swc does (research.md #1).
  plugins: [swc.vite()],
});
