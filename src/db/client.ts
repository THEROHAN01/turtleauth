import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { config } from '../config.js'

/**
 * Prisma client construction.
 *
 * Prisma 7 requires a DRIVER ADAPTER rather than an internal engine connection: the
 * schema describes shape, and the connection is supplied here at runtime. The practical
 * benefit is that the pool is ours — we can size it, and the same `pg` pool semantics
 * apply as if we had written the SQL by hand.
 */
 
export interface DbOptions {
  connectionString?: string
  /** Log every emitted SQL statement. On in dev so the cost of each query is visible. */
  logQueries?: boolean
  /**
   * Max pooled connections.
   *
   * Sizing matters more than it looks: Postgres's own default max_connections is 100,
   * shared across every client. Each app instance holding a large pool starves the
   * others — the classic "too many clients already" outage. Keep it small per instance.
   */
  poolMax?: number
}

export function createPrismaClient(options: DbOptions = {}): PrismaClient {
  const {
    connectionString = config.DATABASE_URL,
    logQueries = config.NODE_ENV === 'development',
    poolMax = 10,
  } = options

  const adapter = new PrismaPg({ connectionString, max: poolMax })

  const client = new PrismaClient({
    adapter,
    // 'event' rather than 'stdout': the raw QueryEvent carries bound params, which for
    // this schema means session tokens, emails and password hashes verbatim. We log
    // only the query shape and duration, never `event.params`.
    log: logQueries ? [{ emit: 'event', level: 'query' }] : [],
  })

  if (logQueries) {
    client.$on('query', (event) => {
      console.log(`${event.query} (${event.duration}ms)`)
    })
  }

  return client
}
