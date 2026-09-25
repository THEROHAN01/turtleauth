/**
 * Password hashing abstraction.
 *
 * Why an interface rather than calling argon2 directly:
 *
 * 1. ALGORITHM MIGRATION. Params live inside the hash string, so on a successful login
 *    — the one moment plaintext exists server-side — we can detect an outdated hash and
 *    silently upgrade it. That works across param changes (bcrypt cost 12 -> 14) AND
 *    across algorithms (bcrypt -> argon2id) with no forced password reset.
 *
 * 2. TESTABILITY. Argon2id at production params costs ~250ms by design. Tests that do
 *    not exercise hashing itself can inject a cheap fake.
 *
 * → notes/module-1-authentication-foundations/3-password-hashing-algorithms
 */

export type HashAlgorithm = 'argon2id' | 'bcrypt'

export interface Hasher {
  /** Which algorithm this instance produces. */
  readonly algorithm: HashAlgorithm

  /** Produce a self-describing hash string (algorithm + params + salt + digest). */
  hash(plaintext: string): Promise<string>

  /**
   * Constant-time verification. Implementations MUST NOT use `===` on digests —
   * a short-circuiting compare leaks information through timing.
   */
  verify(plaintext: string, storedHash: string): Promise<boolean>

  /**
   * True when `storedHash` was produced with weaker settings than this instance's
   * current policy — i.e. it should be re-hashed on next successful login.
   * Must return true for a hash produced by a DIFFERENT algorithm, so that a
   * bcrypt-to-argon2id migration is driven by the same code path.
   */
  needsRehash(storedHash: string): boolean
}

/** Thrown when a stored hash cannot be parsed at all (corrupt or unknown format). */
export class UnknownHashFormatError extends Error {
  constructor(storedHash: string) {
    // Never log the full hash. Prefix only — enough to identify the format.
    super(`Unrecognised password hash format: ${storedHash.slice(0, 12)}...`)
    this.name = 'UnknownHashFormatError'
  }
}

/** Identify which algorithm produced a stored hash, from its prefix. */
export function detectAlgorithm(storedHash: string): HashAlgorithm {
  if (storedHash.startsWith('$argon2')) return 'argon2id'
  // $2a$ / $2b$ / $2y$ are all bcrypt variants.
  if (/^\$2[aby]\$/.test(storedHash)) return 'bcrypt'
  throw new UnknownHashFormatError(storedHash)
}
