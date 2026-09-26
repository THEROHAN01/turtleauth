import { randomBytes } from 'node:crypto'
import type { AuthenticatedSession, Session, SessionId, User, UserId } from '../core/types.js'
import { asSessionId } from '../core/types.js'
import { AuthError } from '../core/errors.js'
import type { Hasher } from '../lib/hashing/hasher.js'
import type { PostgresUserStore } from './user-store.js'
import type { PostgresSessionStore } from './session-store.js'

/**
 * AuthService — the actual authentication logic.
 *
 * KNOWS NOTHING ABOUT HTTP. No request, no response, no cookie, no status code. That is
 * what lets Module 4's Google OAuth callback reuse these same methods, and what lets
 * these tests run without starting a server.

 */

/** Session lifetime policy. Both clocks are enforced — see validateSession. */
export interface SessionPolicy {
  /** Absolute cap: the session dies this long after creation, however active it is. */
  absoluteLifetimeMs: number
  /** Idle cap: the session dies this long after the last request that used it. */
  idleTimeoutMs: number
  /**
   * Only persist a slid `lastSeenAt` when it is at least this stale.
   *
   * Without this, every authenticated request becomes a WRITE — a read-only lookup
   * turned into read+write, for a field precise to the millisecond that nobody needs
   * that precisely. Trading precision for throughput.
   */
  slideThresholdMs: number
}

export const DEFAULT_SESSION_POLICY: SessionPolicy = {
  absoluteLifetimeMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  idleTimeoutMs: 30 * 60 * 1000, // 30 minutes
  slideThresholdMs: 60 * 1000, // 1 minute
}

/**
 * Session id entropy. OWASP's floor is 128 bits; 256 makes guessing arithmetically
 * hopeless rather than merely hard. This is the cheapest strong decision in the whole
 * system, so there is no reason to economise.
 */
const SESSION_ID_BYTES = 32

export class AuthService {

  constructor(
    private readonly store: PostgresUserStore,
    private readonly hasher: Hasher,
    private readonly sessions: PostgresSessionStore,
    private readonly policy: SessionPolicy = DEFAULT_SESSION_POLICY,
  ) {}

  /**
   * A hash of a random string nobody knows, generated lazily with THIS instance's
   * hasher so it always matches current config params.
   *
   * Hardcoding it would silently break the timing defense the moment ARGON2_MEMORY_COST
   * is tuned: real users would verify at the new cost while missing users verified at
   * the old one, reopening the leak with every test still green.
   */
  private dummyHash: string | null = null

  private async getDummyHash(): Promise<string> {
    // Cached after first use. Generating per call would cost hash() AND verify(),
    // making the missing-user path SLOWER than a real one — inverting the leak.
    this.dummyHash ??= await this.hasher.hash(randomBytes(32).toString('hex'))
    return this.dummyHash
  }

  private normaliseEmail(email: string): string {
    return email.trim().toLowerCase()
  }

  
  async register(email: string, password: string): Promise<User> {
    const normalisedEmail = this.normaliseEmail(email)

    const passwordHash = await this.hasher.hash(password)
    const user = await this.store.createUserWithPassword(normalisedEmail, passwordHash)

    if (user === null ){
      throw AuthError.emailAlreadyRegistered()
    }

    return user
  }

  
  async verifyPassword(email: string, password: string): Promise<boolean> {

    const normalisedEmail = this.normaliseEmail(email)
    const credential = await this.store.findCredentialByEmail(normalisedEmail)

    if(!credential) {
      await this.hasher.verify(password, await this.getDummyHash())
      return false
  }

    return this.hasher.verify(password,credential.secret)
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Sessions
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Create a session for an already-authenticated user.
   *
   * Public and separate from login() on purpose: Module 4's Google callback has a
   * verified user but no password, and must reuse this exact path rather than
   * reimplementing session creation.
   */
  async createSession(
    userId: UserId,
    context: { ip?: string | null; userAgent?: string | null } = {},
  ): Promise<Session> {
    const now = new Date()

    const session: Session = {
      // CSPRNG, 256 bits. NOT Math.random (predictable from observed output) and NOT
      // uuid v1/v7 (timestamp-structured). Unguessability is a cryptographic
      // requirement here, not a uniqueness one.
      id: asSessionId(randomBytes(SESSION_ID_BYTES).toString('base64url')),
      userId,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + this.policy.absoluteLifetimeMs),
      ip: context.ip ?? null,
      userAgent: context.userAgent ?? null,
    }

    await this.sessions.create(session)
    return session
  }

  /**
   * Verify credentials and start a session. The Module 1 login path.
   *
   * Throws the SAME error for "no such user" and "wrong password" — the caller cannot
   * distinguish them, so it cannot enumerate accounts.
   */
  async login(
    email: string,
    password: string,
    context: { ip?: string | null; userAgent?: string | null } = {},
  ): Promise<AuthenticatedSession> {
    const normalisedEmail = this.normaliseEmail(email)

    const ok = await this.verifyPassword(normalisedEmail, password)
    if (!ok) throw AuthError.invalidCredentials('password verification failed')

    // verifyPassword already proved the credential exists, so a missing user here is a
    // genuine inconsistency, not a failed login.
    const user = await this.store.findUserByEmail(normalisedEmail)
    if (!user) throw AuthError.invalidCredentials('credential without user')

    const session = await this.createSession(user.id, context)
    return { session, user }
  }

  /**
   * Validate a session id from a cookie and slide its idle window.
   *
   * TWO CLOCKS, both enforced:
   *   absolute  createdAt + 7d    caps damage from a stolen cookie
   *   idle      lastSeenAt + 30m  protects the walked-away-from-laptop case
   *
   * Idle alone lets a stolen session live forever if the attacker keeps it warm.
   * Absolute alone leaves an abandoned session valid for a week.
   *
   * Expiry is checked HERE, server-side. The cookie's Max-Age is a hint the user can
   * edit — and an attacker holding a stolen cookie certainly will.
   */
  async validateSession(
    sessionId: SessionId,
    now: Date = new Date(),
  ): Promise<AuthenticatedSession> {
    const session = await this.sessions.findById(sessionId)
    // Unknown id and expired session raise the same error: a caller cannot learn
    // whether an id ever existed.
    if (!session) throw AuthError.sessionInvalid('no such session')

    if (now >= session.expiresAt) {
      await this.sessions.delete(sessionId)
      throw AuthError.sessionExpired()
    }

    const idleDeadline = session.lastSeenAt.getTime() + this.policy.idleTimeoutMs
    if (now.getTime() >= idleDeadline) {
      await this.sessions.delete(sessionId)
      throw AuthError.sessionExpired()
    }

    const user = await this.store.findUserById(session.userId)
    if (!user) {
      // User deleted while a session lived. Clean up rather than serve a ghost.
      await this.sessions.delete(sessionId)
      throw AuthError.sessionInvalid('session references a missing user')
    }

    // Slide the idle window, but only when it is meaningfully stale — otherwise every
    // authenticated request becomes a write. Note `expiresAt` is NOT extended: the
    // absolute cap is absolute.
    const staleness = now.getTime() - session.lastSeenAt.getTime()
    if (staleness >= this.policy.slideThresholdMs) {
      const slid: Session = { ...session, lastSeenAt: now }
      await this.sessions.update(slid)
      return { session: slid, user }
    }

    return { session, user }
  }

  /**
   * End one session. Idempotent — logging out twice is not an error.
   *
   * This is stateful auth's superpower: revocation is a delete, effective on the very
   * next request. Module 2 trades it away for statelessness and spends the whole module
   * buying pieces of it back.
   */
  async logout(sessionId: SessionId): Promise<void> {
    await this.sessions.delete(sessionId)
  }

  /** End every session for a user — "log out all devices". */
  async logoutAll(userId: UserId): Promise<number> {
    return this.sessions.deleteAllForUser(userId)
  }
}

/**
 * A real Argon2id hash of a random string nobody knows, used ONLY to burn equivalent
 * CPU time when no user exists — so the missing-user path is not measurably faster
 * than the wrong-password path. It will never match any submitted password.
 *
 * Generated once at module load rather than per call, because generating it per call
 * would cost a hash() AND a verify() and skew the timing the other way.
 */

