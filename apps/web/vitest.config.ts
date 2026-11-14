import { defineConfig } from 'vitest/config';

/**
 * Component tests run in jsdom; the older node:test files under src/lib still run through `tsx --test`.
 * CSS imports are stubbed: components are tested for behaviour, not looks.
 */
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.tsx'],
    globals: false,
    restoreMocks: true,
    css: false,
  },
});
