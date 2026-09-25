import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
    // Argon2id verification is deliberately slow (~250ms). Hashing tests need headroom.
    testTimeout: 20_000,
  },
})
