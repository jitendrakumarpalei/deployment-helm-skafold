import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['../../tests/ledger/**/*.test.ts', '../../tests/langchain/**/*.test.ts'],
    hookTimeout: 120_000,
    testTimeout: 120_000
  }
});
