/**
 * Domain types. No HTTP, no SQL, no framework imports — this is the innermost layer.
 */

export type UserId = string & { readonly __brand: 'UserId' }
export type SessionId = string & { readonly __brand: 'SessionId' }
export type CredentialId = string & { readonly __brand: 'CredentialId' }

export const asUserId = (s: string) => s as UserId
export const asSessionId = (s: string) => s as SessionId
export const asCredentialId = (s: string) => s as CredentialId

/**
 * Identity: attributes the system knows about a subject.
 * Deliberately holds NO password hash — credentials are a separate entity, because
 * one identity has many credentials (password + passkey + Google), and Module 5
 * would otherwise require surgery on the most-referenced table.
 * → notes/module-1.../1-authentication-fundamentals
 */
export interface User {
  id: UserId
  email: string
  emailVerifiedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

/** A credential proves control of an identity. Password is only the first kind. */
export type CredentialType = 'password'

export interface Credential {
  id: CredentialId
  userId: UserId
  type: CredentialType
  /**
   * Self-describing hash: algorithm, version, params and salt are all encoded in this
   * one string (e.g. `$argon2id$v=19$m=65536,t=3,p=4$<salt>$<hash>`). That is what
   * makes transparent rehashing on login possible without extra columns.
   */
  secret: string
  createdAt: Date
  updatedAt: Date
}

/**
 * Session: the server-side truth a session cookie points at.
 * The cookie carries only the opaque id; everything meaningful lives here.
 */
export interface Session {
  id: SessionId
  userId: UserId
  /** Absolute deadline — the session dies here no matter how active it is. */
  expiresAt: Date
  /** Drives the idle timeout, sliding as the user stays active. */
  lastSeenAt: Date
  createdAt: Date
  /** Weak signals: useful for audit and anomaly detection, never an auth decision alone. */
  ip: string | null
  userAgent: string | null
}

/** What a successful authentication yields. */
export interface AuthenticatedSession {
  session: Session
  user: User
}
