/**
 * Error taxonomy for TurtleAuth.
 *
 * Two rules drive the design:
 *
 * 1. Services throw domain errors that know nothing about HTTP. The route layer maps
 *    them to status codes. This keeps AuthService reusable from an OAuth callback
 *    (Module 4) or an admin surface, not just a REST handler.
 *
 * 2. What the CLIENT sees and what we LOG are deliberately different. Login failures
 *    must not reveal whether the email existed — that is account enumeration
 *    (see notes/module-1.../2-password-authentication). So `publicMessage` is
 *    intentionally vague while `message` carries the real cause for the audit log.
 */

export type AuthErrorCode =
  | 'INVALID_CREDENTIALS'
  | 'EMAIL_ALREADY_REGISTERED'
  | 'SESSION_INVALID'
  | 'SESSION_EXPIRED'
  | 'NOT_AUTHENTICATED'
  | 'VALIDATION_FAILED'

export class AuthError extends Error {
  readonly code: AuthErrorCode
  readonly status: number
  /** Safe to return to an unauthenticated caller. Must not leak account existence. */
  readonly publicMessage: string

  constructor(
    code: AuthErrorCode,
    status: number,
    publicMessage: string,
    internalMessage?: string,
  ) {
    super(internalMessage ?? publicMessage)
    this.name = 'AuthError'
    this.code = code
    this.status = status
    this.publicMessage = publicMessage
  }

  /**
   * Deliberately identical for "no such user" and "wrong password".
   * The caller cannot distinguish them, so it cannot enumerate accounts.
   * `internalMessage` records the real reason for our own logs.
   */
  static invalidCredentials(internalMessage?: string): AuthError {
    return new AuthError(
      'INVALID_CREDENTIALS',
      401,
      'Invalid email or password.',
      internalMessage,
    )
  }

  /**
   * NOTE: registration inherently leaks existence — a service that lets anyone
   * register must tell them the address is taken. Mitigation is rate limiting and
   * (later) email-verification flows that respond identically either way.
   * → Module 3 account enumeration.
   */
  static emailAlreadyRegistered(): AuthError {
    return new AuthError(
      'EMAIL_ALREADY_REGISTERED',
      409,
      'That email address is already registered.',
    )
  }

  static sessionInvalid(internalMessage?: string): AuthError {
    return new AuthError('SESSION_INVALID', 401, 'Not authenticated.', internalMessage)
  }

  static sessionExpired(): AuthError {
    return new AuthError('SESSION_EXPIRED', 401, 'Not authenticated.', 'session expired')
  }

  static notAuthenticated(): AuthError {
    return new AuthError('NOT_AUTHENTICATED', 401, 'Not authenticated.')
  }
}

export function isAuthError(e: unknown): e is AuthError {
  return e instanceof AuthError
}
