import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    env: { PULSE_RUNTIME: 'test' },
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Integration tests share one runtime dir + policies.json; run files serially.
    fileParallelism: false,
  },
})
