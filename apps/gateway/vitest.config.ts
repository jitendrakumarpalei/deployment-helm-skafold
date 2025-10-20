import { defineConfig } from 'vitest/config';
import path from 'node:path';

const sharedSrc = path.resolve(__dirname, '../shared/src');

export default defineConfig({
  resolve: {
    alias: {
      '@stringcost/shared': sharedSrc,
    },
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['../../tests/gateway/**/*.test.ts']
  }
});
