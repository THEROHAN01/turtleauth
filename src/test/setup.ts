import 'dotenv/config'

/**
 * Runs before every test file. Its only job is loading .env early enough that
 * src/test/db.ts can read DATABASE_URL.
 */
if (!process.env['DATABASE_URL']) {
  throw new Error(
    'DATABASE_URL is not set.\n\n' +
      'Integration tests need a running database:\n' +
      '  pnpm db:up\n\n' +
      'If the container is already up, check that .env exists (copy .env.example).',
  )
}
