import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e/**', 'tests/browser/**'],
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/main.ts', 'src/healthcheck.ts', 'src/lang/registry.ts'],
      reporter: ['text-summary', 'lcov', 'json-summary'],
    },
  },
});
