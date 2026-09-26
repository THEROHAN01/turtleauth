import { defineConfig } from 'vitest/config'
import 'dotenv/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
    // Argon2id verification is deliberately slow (~250ms). Hashing tests need headroom,
    // and integration tests now pay a database round trip on top.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    /**
     * Load .env before any test module is imported, so src/test/db.ts sees DATABASE_URL.
     * Without this it reads process.env before config.ts (which calls dotenv) has run.
     */
    setupFiles: ['src/test/setup.ts'],
    /**
     * Run test FILES one at a time. They share one database schema, so parallel files
     * would truncate each other's fixtures mid-run.
     *
     * The alternative — a schema per file — does not work with Prisma: the generated
     * client bakes schema.prisma's schema name into its SQL and ignores the connection's
     * search_path, so model queries always hit `public` while raw setup queries hit the
     * per-file schema. See src/test/db.ts.
     */
    fileParallelism: false,
  },
})
