import Fastify, { type FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import { config } from './config.js'
import { Argon2Hasher } from './lib/hashing/argon2-hasher.js'
import { InMemoryUserStore } from './services/user-store.js'
import { InMemorySessionStore } from './services/session-store.js'
import { AuthService, DEFAULT_SESSION_POLICY, type SessionPolicy } from './services/auth-service.js'
import { authErrorHandler, registerAuthRoutes } from './routes/auth-routes.js'

/**
 * Wiring only. Kept separate from server.ts so tests can build an app and call it via
 * `app.inject()` — no port, no network, no cleanup — while production binds a socket.
 */

export interface BuildAppOptions {
  /** Override for tests (cheap hash params keep the suite fast). */
  hasher?: Argon2Hasher
  sessionPolicy?: SessionPolicy
  /** false for local dev over plain http; must be true in production. */
  secureCookies?: boolean
  logger?: boolean
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const {
    hasher = new Argon2Hasher({
      memoryCost: config.ARGON2_MEMORY_COST,
      timeCost: config.ARGON2_TIME_COST,
      parallelism: config.ARGON2_PARALLELISM,
    }),
    sessionPolicy = DEFAULT_SESSION_POLICY,
    // Plain http is only acceptable locally. Anything else gets Secure cookies.
    secureCookies = config.NODE_ENV === 'production',
    logger = config.NODE_ENV !== 'test',
  } = options

  const app = Fastify({
    logger,
    /**
     * Cap the request body. Zod bounds the password field, but that check runs only
     * AFTER the whole body is parsed — so without this, a huge payload consumes memory
     * and CPU before validation ever sees it.
     */
    bodyLimit: 64 * 1024, // 64 KB
  })

  app.register(cookie)

  const userStore = new InMemoryUserStore()
  const sessionStore = new InMemorySessionStore()
  const auth = new AuthService(userStore, hasher, sessionStore, sessionPolicy)

  app.setErrorHandler(authErrorHandler)

  app.get('/health', async () => ({ status: 'ok' }))

  app.register(async (instance) => {
    await registerAuthRoutes(instance, {
      auth,
      secureCookies,
      // Browser hint mirrors the server's absolute cap. Server truth still wins.
      cookieMaxAgeSeconds: Math.floor(sessionPolicy.absoluteLifetimeMs / 1000),
    })
  })

  return app
}
