import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['../../tests/control-plane/**/*.test.ts'],
    hookTimeout: 120_000,
    testTimeout: 60_000
  }
});
