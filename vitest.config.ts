import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/backend/src/**/*.test.ts', 'apps/publisher/src/**/*.test.ts', 'apps/web/src/lib/**/*.test.ts', 'scripts/**/*.test.ts'],
    environment: 'node',
  },
});
