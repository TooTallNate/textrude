import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Geometry and mesh checks on whole designs take a few seconds each.
    testTimeout: 60_000,
  },
});
