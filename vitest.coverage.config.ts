import { defineConfig } from 'vitest/config';
import unit from './vitest.config.js';
export default defineConfig({
  test: {
    ...unit.test,
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/browser/**'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
