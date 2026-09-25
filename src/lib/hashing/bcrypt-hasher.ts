import bcrypt from 'bcrypt'
import { type Hasher, type HashAlgorithm, detectAlgorithm } from './hasher.js'

/**
 * bcrypt — included for comparison and migration, not as the default.
 *
 * Two real limitations, both worth understanding rather than memorising:
 *
 * 1. 72-BYTE TRUNCATION. bcrypt silently ignores input past 72 bytes, so
 *    "<70 chars>AAAA" and "<70 chars>BBBB" can hash identically. A user's long
 *    passphrase is quietly weakened. `BCRYPT_MAX_BYTES` below makes this explicit
 *    rather than silent — see `exceedsBcryptInputLimit`.
 *
 * 2. CPU-HARD ONLY. No memory hardness, so GPUs parallelise it far better than
 *    Argon2id. This is the main reason it is not our default.
 *
 * → notes/module-1-authentication-foundations/3-password-hashing-algorithms
 */

export const BCRYPT_MAX_BYTES = 72

/** Current OWASP-aligned minimum. Each +1 doubles the work. */
export const BCRYPT_DEFAULT_COST = 12

export class BcryptHasher implements Hasher {
  readonly algorithm: HashAlgorithm = 'bcrypt'
  private readonly cost: number

  constructor(cost: number = BCRYPT_DEFAULT_COST) {
    this.cost = cost
  }

  async hash(plaintext: string): Promise<string> {
    return bcrypt.hash(plaintext, this.cost)
  }

  async verify(plaintext: string, storedHash: string): Promise<boolean> {
    try {
      // bcrypt.compare reads the cost and salt from the hash and compares in constant time.
      return await bcrypt.compare(plaintext, storedHash)
    } catch {
      return false
    }
  }

  needsRehash(storedHash: string): boolean {
    let algorithm: HashAlgorithm
    try {
      algorithm = detectAlgorithm(storedHash)
    } catch {
      return true
    }
    if (algorithm !== 'bcrypt') return true

    const cost = parseBcryptCost(storedHash)
    if (cost === null) return true
    return cost < this.cost
  }
}

/** Parse the cost factor from `$2b$12$<salt+digest>`. */
export function parseBcryptCost(storedHash: string): number | null {
  const match = /^\$2[aby]\$(\d{2})\$/.exec(storedHash)
  if (!match?.[1]) return null
  const cost = Number.parseInt(match[1], 10)
  return Number.isNaN(cost) ? null : cost
}

/**
 * True when bcrypt would silently truncate this input.
 *
 * Note it is BYTES, not characters: a multi-byte character (emoji, non-Latin script)
 * consumes far more than one byte, so a 30-character password can exceed the limit.
 * Callers should reject rather than silently accept a weakened password.
 */
export function exceedsBcryptInputLimit(plaintext: string): boolean {
  return Buffer.byteLength(plaintext, 'utf8') > BCRYPT_MAX_BYTES
}
