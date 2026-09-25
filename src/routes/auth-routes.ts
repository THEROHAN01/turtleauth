import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { asSessionId, type User } from '../core/types.js'
import { AuthError, isAuthError } from '../core/errors.js'
import type { AuthService } from '../services/auth-service.js'
import {
  clearSessionCookieOptions,
  sessionCookieName,
  sessionCookieOptions,
} from './cookie.js'

/**
 * HTTP layer. Deliberately THIN.
 *
 * Its whole job: parse and validate input, call AuthService, translate the result into
 * a status code and a cookie. No auth logic lives here — that is what lets Module 4's
 * OAuth callback reuse the same service without touching any of this.
 */

/**
 * Runtime validation. TypeScript types vanish at compile time, so `request.body` is
 * genuinely `any` until something checks it. This is the trust boundary in code:
 * never trust what crossed in from the client.
 */
const credentialsSchema = z.object({
  email: z.string().trim().min(3).max(320).email(),
  /**
   * min(8): a floor, not a policy. Real strength comes from length and from breach
   * checks (→ Module 3), not from character-class rules that push users toward
   * "Passw0rd!".
   *
   * max(200): a DoS guard, and the important one. Argon2 costs ~250ms on a normal
   * password; hand it a 10MB string and that becomes an attacker-controlled amount of
   * CPU on an UNAUTHENTICATED endpoint. Bound it before it reaches the hasher.
   */
  password: z.string().min(8).max(200),
})

interface RouteOptions {
  auth: AuthService
  /** false only for local dev over plain http. */
  secureCookies: boolean
  /** Mirrors the session policy so the browser hint roughly matches server truth. */
  cookieMaxAgeSeconds: number
}

/** Shape sent to clients. Never leak internal fields by serialising a domain object. */
function publicUser(user: User) {
  return {
    id: user.id,
    email: user.email,
    emailVerified: user.emailVerifiedAt !== null,
    createdAt: user.createdAt.toISOString(),
  }
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  { auth, secureCookies, cookieMaxAgeSeconds }: RouteOptions,
): Promise<void> {
  const cookieName = sessionCookieName(secureCookies)

  /** Pull request context for the audit trail. Signals only, never auth decisions. */
  function context(request: FastifyRequest) {
    return {
      ip: request.ip ?? null,
      userAgent: request.headers['user-agent'] ?? null,
    }
  }

  function setSessionCookie(reply: FastifyReply, sessionId: string): void {
    reply.setCookie(
      cookieName,
      sessionId,
      sessionCookieOptions({ secure: secureCookies, maxAgeSeconds: cookieMaxAgeSeconds }),
    )
  }

  // ── POST /auth/register ──────────────────────────────────────────────────────
  app.post('/auth/register', async (request, reply) => {
    const parsed = credentialsSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'VALIDATION_FAILED',
        message: 'Email must be valid and password at least 8 characters.',
      })
    }

    const { email, password } = parsed.data
    const user = await auth.register(email, password)

    /**
     * Registration auto-logs-in. A deliberate product choice, not a security one:
     * the user just proved they chose this password, so requiring an immediate second
     * login is friction with no benefit.
     *
     * Note this does NOT verify they own the email address. Until email verification
     * exists (Module 5), a session here means "chose this password", not "owns this
     * inbox" — fine for sign-in, not enough for anything that trusts the address.
     */
    const session = auth.createSession(user.id, context(request))
    setSessionCookie(reply, session.id)

    return reply.code(201).send({ user: publicUser(user) })
  })

  // ── POST /auth/login ─────────────────────────────────────────────────────────
  app.post('/auth/login', async (request, reply) => {
    const parsed = credentialsSchema.safeParse(request.body)
    if (!parsed.success) {
      /**
       * Deliberately the SAME 401 a wrong password gets — not a 400.
       *
       * A 400 would tell an attacker "that email is malformed" while a 401 says
       * "wrong credentials", which is a free oracle for probing input handling. The
       * login endpoint should have exactly one failure shape.
       */
      return reply.code(401).send({
        error: 'INVALID_CREDENTIALS',
        message: 'Invalid email or password.',
      })
    }

    const { email, password } = parsed.data
    const { session, user } = await auth.login(email, password, context(request))

    /**
     * A fresh session id on every login is what defeats SESSION FIXATION: an attacker
     * who planted a known id in the victim's browser sees it discarded at exactly the
     * moment it would have become valuable. createSession() always mints a new id, so
     * this holds by construction.
     */
    setSessionCookie(reply, session.id)

    return reply.send({ user: publicUser(user) })
  })

  // ── GET /auth/me ─────────────────────────────────────────────────────────────
  app.get('/auth/me', async (request, reply) => {
    const sessionId = request.cookies[cookieName]
    if (!sessionId) throw AuthError.notAuthenticated()

    // Expiry is checked in here — SERVER-side. The cookie's Max-Age is only a hint.
    const { user, session } = auth.validateSession(asSessionId(sessionId))

    return reply.send({
      user: publicUser(user),
      session: {
        createdAt: session.createdAt.toISOString(),
        expiresAt: session.expiresAt.toISOString(),
      },
    })
  })

  // ── POST /auth/logout ────────────────────────────────────────────────────────
  app.post('/auth/logout', async (request, reply) => {
    const sessionId = request.cookies[cookieName]

    /**
     * Delete server-side AND clear the cookie. Clearing only the cookie would leave a
     * live session that any copy of the value still opens.
     */
    if (sessionId) auth.logout(asSessionId(sessionId))
    reply.clearCookie(cookieName, clearSessionCookieOptions(secureCookies))

    /**
     * Always 204, even with no session. Logout has nothing to reveal, and an error
     * here would tell a caller whether a given id was live.
     */
    return reply.code(204).send()
  })

  // ── POST /auth/logout-all ────────────────────────────────────────────────────
  app.post('/auth/logout-all', async (request, reply) => {
    const sessionId = request.cookies[cookieName]
    if (!sessionId) throw AuthError.notAuthenticated()

    const { user } = auth.validateSession(asSessionId(sessionId))
    const count = auth.logoutAll(user.id)
    reply.clearCookie(cookieName, clearSessionCookieOptions(secureCookies))

    return reply.send({ sessionsEnded: count })
  })
}

/**
 * Translate domain errors into HTTP responses.
 *
 * Registered once for the whole app so no handler has to remember it. Two rules:
 *   - the client sees `publicMessage`, which never reveals account existence
 *   - the server logs `message`, which carries the real cause
 */
export function authErrorHandler(
  error: Error,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  if (isAuthError(error)) {
    // Internal detail goes to the log, not the response.
    request.log.info(
      { code: error.code, reason: error.message, path: request.url },
      'auth failure',
    )
    void reply.code(error.status).send({
      error: error.code,
      message: error.publicMessage,
    })
    return
  }

  /**
   * Unexpected error: log it fully, tell the client nothing. Stack traces and driver
   * messages in a response body are an information-disclosure bug.
   */
  request.log.error({ err: error, path: request.url }, 'unhandled error')
  void reply.code(500).send({
    error: 'INTERNAL_ERROR',
    message: 'Something went wrong.',
  })
}
