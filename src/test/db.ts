import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'

/**
 * Test database helpers.
 *
 * v0.1.0 tested against in-memory Maps and ran in ~300ms with no infrastructure. That
 * version is gone: a suite that passes against a Map never proved the SQL path worked.
 * Tests now need a running Postgres and are slower — accepted so that what is tested is
 * what ships.
 *
 * ISOLATION: a single shared schema, with test FILES RUN SERIALLY.
 *
 * Per-file schemas were tried first and do not work with Prisma. The generated client
 * bakes the schema name from schema.prisma into its SQL, so `prisma.user.create()` always
 * targets `public` no matter what `search_path` the connection carries. Raw queries DO
 * honour search_path, which makes the failure especially confusing: setup and assertions
 * read one schema while the code under test writes another, and a fresh-looking schema
 * reports a duplicate-email error.
 *
 * Making that work would mean generating a client per schema — far more machinery than
 * a `singleThread` flag. The cost of serialising is wall-clock time, not correctness.
 */

function databaseUrl(): string {
  const url = process.env['DATABASE_URL']
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Integration tests need a database:\n  pnpm db:up\n',
    )
  }
  return url
}

export interface TestDb {
  prisma: PrismaClient
  cleanup: () => Promise<void>
}

/**
 * Connect to the test database.
 *
 * Assumes migrations have been applied (`pnpm db:migrate` or `pnpm db:up` then
 * `prisma migrate deploy`). Applying them here per file would mean spawning the CLI
 * repeatedly.
 */
export async function createTestDb(): Promise<TestDb> {
  const adapter = new PrismaPg({ connectionString: databaseUrl(), max: 5 })
  const prisma = new PrismaClient({ adapter })

  // Fail with something actionable rather than a raw SQL error if migrations are missing.
  try {
    await prisma.user.count()
  } catch {
    await prisma.$disconnect()
    throw new Error(
      'Database schema is missing. Apply migrations first:\n' +
        '  pnpm db:up && pnpm exec prisma migrate deploy\n',
    )
  }

  return {
    prisma,
    cleanup: async () => {
      await truncateAll(prisma)
      await prisma.$disconnect()
    },
  }
}

/**
 * Wipe every table between tests.
 *
 * CASCADE follows the foreign keys, so truncating users clears credentials and sessions
 * with it. RESTART IDENTITY is unnecessary here — no table uses a sequence.
 */
export async function truncateAll(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE "users" CASCADE`)
}
