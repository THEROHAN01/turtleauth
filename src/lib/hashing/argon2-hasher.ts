import argon2 from 'argon2'
import { type Hasher, type HashAlgorithm, detectAlgorithm } from './hasher.js'

/**
 * Argon2id — current OWASP first choice, and TurtleAuth's default.
 *
 * `id` is the hybrid variant: Argon2d's resistance to time-memory tradeoffs plus
 * Argon2i's resistance to side-channel timing attacks. Never use plain d or i here.
 *
 * MEMORY HARDNESS is the property that matters: computing the hash requires holding a
 * large block of RAM, and RAM is expensive to replicate across thousands of GPU cores.
 * That is what bcrypt (CPU-hard only) does not give you.
 */
export interface Argon2Params {
  /** Memory cost in KiB. OWASP baseline 19456 (19 MiB); stronger 65536 (64 MiB). */
  memoryCost: number
  /** Time cost — number of passes over memory. */
  timeCost: number
  /** Degree of parallelism. */
  parallelism: number
}

export const ARGON2_DEFAULTS: Argon2Params = {
  memoryCost: 65536, // 64 MiB
  timeCost: 3,
  parallelism: 4,
}

export class Argon2Hasher implements Hasher {
  readonly algorithm: HashAlgorithm = 'argon2id'
  private readonly params: Argon2Params

  constructor(params: Argon2Params = ARGON2_DEFAULTS) {
    this.params = params
  }

  async hash(plaintext: string): Promise<string> {
    return argon2.hash(plaintext, {
      type: argon2.argon2id,
      memoryCost: this.params.memoryCost,
      timeCost: this.params.timeCost,
      parallelism: this.params.parallelism,
    })
  }

  async verify(plaintext: string, storedHash: string): Promise<boolean> {
    try {
      // argon2.verify parses params out of the hash itself and compares in constant time.
      return await argon2.verify(storedHash, plaintext)
    } catch {
      // Malformed/foreign hash: report "does not match" rather than throwing, so the
      // caller's failure path stays uniform and does not leak via a distinct error.
      return false
    }
  }

  needsRehash(storedHash: string): boolean {
    // A different algorithm always needs migrating to this one.
    let algorithm: HashAlgorithm
    try {
      algorithm = detectAlgorithm(storedHash)
    } catch {
      return true // unparseable -> replace it on next successful login
    }
    if (algorithm !== 'argon2id') return true

    const parsed = parseArgon2Params(storedHash)
    if (!parsed) return true

    // Rehash only when the stored hash is WEAKER than current policy. A stronger hash
    // (e.g. set by a future policy, or during a staged rollout) is left alone.
    return (
      parsed.memoryCost < this.params.memoryCost ||
      parsed.timeCost < this.params.timeCost ||
      parsed.parallelism < this.params.parallelism
    )
  }
}

/**
 * Parse `$argon2id$v=19$m=65536,t=3,p=4$<salt>$<hash>`.
 * Note: the `argon2` package emits params in `m,p,t` order in some versions and
 * `m,t,p` in others, so parse by KEY rather than by position.
 */
export function parseArgon2Params(storedHash: string): Argon2Params | null {
  const match = /\$argon2(?:id|i|d)\$v=\d+\$([^$]+)\$/.exec(storedHash)
  if (!match?.[1]) return null

  const values: Record<string, number> = {}
  for (const pair of match[1].split(',')) {
    const [key, raw] = pair.split('=')
    if (!key || !raw) continue
    const n = Number.parseInt(raw, 10)
    if (Number.isNaN(n)) return null
    values[key] = n
  }

  const { m, t, p } = values
  if (m === undefined || t === undefined || p === undefined) return null
  return { memoryCost: m, timeCost: t, parallelism: p }
}
