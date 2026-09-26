import 'dotenv/config'
import { z } from 'zod'

/**
 * Configuration, validated at startup.
 *
 * Fail fast and loudly: a missing or malformed security parameter must stop the process,
 * never silently fall back to something weaker. A service that boots with a bad work
 * factor is worse than one that refuses to boot.
 */

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  /**
   * Postgres connection string. No default: a missing DATABASE_URL must stop the
   * process, not silently fall back to some other database.
   */
  DATABASE_URL: z.string().url(),

  /**
   * Argon2id work factor.
   *
   * MEASURED on this dev machine (node 22, x64) with `pnpm bench:hash`:
   *   m=64MiB  t=3 p=4  ->  37ms   (too fast)
   *   m=128MiB t=4 p=4  ->  97ms   (too fast)
   *   m=256MiB t=4 p=4  -> 200ms   (in the 200-500ms band)
   *
   * Default kept at 64MiB — the OWASP-aligned value — rather than the locally-measured
   * 256MiB, for one reason worth remembering:
   *
   *   memoryCost is per CONCURRENT hash. 256MiB x 10 simultaneous logins = 2.5GB.
   *   Raising it trades login throughput and RAM headroom for offline-cracking
   *   resistance, and every FAILED login pays the same cost — which an attacker
   *   controls. (→ Module 3: this is the same decision as rate limiting.)
   *
   * Re-run `pnpm bench:hash` on the real production container and set these via env
   * once the memory budget is known. Do not copy a number measured on a laptop.
   */
  ARGON2_MEMORY_COST: z.coerce.number().int().min(8192).default(65536),
  ARGON2_TIME_COST: z.coerce.number().int().min(1).default(3),
  ARGON2_PARALLELISM: z.coerce.number().int().min(1).default(4),
})

const parsed = schema.safeParse(process.env)

if (!parsed.success) {
  console.error('Invalid configuration:')
  console.error(z.prettifyError(parsed.error))
  process.exit(1)
}

export const config = parsed.data
export type Config = typeof config
