import 'dotenv/config'
import { defineConfig, env } from 'prisma/config'

/**
 * Prisma 7 moved the connection URL out of schema.prisma: the schema now describes
 * shape only, and connection details live here (for the CLI) and in the client's
 * driver adapter (for runtime).
 *
 * The practical effect is that the schema file is environment-agnostic — it cannot
 * accidentally carry a connection string into version control.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
})
