import { randomUUID } from 'node:crypto'
import type { User, Credential, UserId } from '../core/types.js'
import { asUserId, asCredentialId } from '../core/types.js'

/**
 * In-memory user + credential storage.
 *
 * Deliberately NOT behind an interface yet. We have exactly one implementation and no
 * evidence for what a second one needs. When Postgres arrives we will extract the
 * interface from two real implementations instead of guessing at one.
 *
 * Users and credentials are stored separately, mirroring the domain model: one identity
 * may hold many credentials (password now; passkey and OAuth later).
 */
export class InMemoryUserStore {
  private readonly users = new Map<UserId, User>()
  /** Secondary index: normalised email -> user id. Postgres will do this with UNIQUE. */
  private readonly emailIndex = new Map<string, UserId>()
  private readonly credentials = new Map<UserId, Credential>()

  /**
   * Insert a user and their password credential together.
   *
   * Returns null if the email is already taken. Note this check and the insert happen
   * in one synchronous block, so there is no interleaving — single-threaded JS gives us
   * atomicity for free here. Postgres will NOT, which is why the real table needs a
   * UNIQUE constraint rather than a check-then-insert. (Module 6.)
   */
  createUserWithPassword(normalisedEmail: string, passwordHash: string): User | null {
    if (this.emailIndex.has(normalisedEmail)) return null

    const now = new Date()
    const id = asUserId(randomUUID())

    const user: User = {
      id,
      email: normalisedEmail,
      emailVerifiedAt: null,
      createdAt: now,
      updatedAt: now,
    }

    const credential: Credential = {
      id: asCredentialId(randomUUID()),
      userId: id,
      type: 'password',
      secret: passwordHash,
      createdAt: now,
      updatedAt: now,
    }

    this.users.set(id, user)
    this.emailIndex.set(normalisedEmail, id)
    this.credentials.set(id, credential)

    return user
  }

  findUserByEmail(normalisedEmail: string): User | undefined {
    const id = this.emailIndex.get(normalisedEmail)
    return id ? this.users.get(id) : undefined
  }

  findUserById(id: UserId): User | undefined {
    return this.users.get(id)
  }

  findCredentialByEmail(normalisedEmail: string): Credential | undefined {
    const id = this.emailIndex.get(normalisedEmail)
    return id ? this.credentials.get(id) : undefined
  }

  /** Replace a stored hash — used by transparent rehash-on-login. */
  updatePasswordHash(userId: UserId, newHash: string): void {
    const existing = this.credentials.get(userId)
    if (!existing) return
    this.credentials.set(userId, { ...existing, secret: newHash, updatedAt: new Date() })
  }
}
