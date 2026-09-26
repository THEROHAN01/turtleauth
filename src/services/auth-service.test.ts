import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import { AuthService } from './auth-service.js'
import { PostgresUserStore } from './user-store.js'
import { PostgresSessionStore } from './session-store.js'
import { Argon2Hasher } from '../lib/hashing/argon2-hasher.js'
import { AuthError } from '../core/errors.js'
import { createTestDb, truncateAll, type TestDb } from '../test/db.js'

// Weak params so the suite stays fast. Real cost comes from config in production.
const hasher = new Argon2Hasher({ memoryCost: 8192, timeCost: 1, parallelism: 1 })

let db: TestDb
let store: PostgresUserStore
let sessionStore: PostgresSessionStore
let auth: AuthService

beforeAll(async () => {
  db = await createTestDb()
  store = new PostgresUserStore(db.prisma)
  sessionStore = new PostgresSessionStore(db.prisma)
  auth = new AuthService(store, hasher, sessionStore)
})

afterAll(async () => {
  await db.cleanup()
})

beforeEach(async () => {
  await truncateAll(db.prisma)
})

describe('register', () => {
  it('creates a user and returns it without any secret material', async () => {
    const user = await auth.register('rohan@kpoint.com', 'correct horse battery staple')

    expect(user.email).toBe('rohan@kpoint.com')
    expect(user.id).toBeTruthy()
    expect(user.emailVerifiedAt).toBeNull()

    // A User object must never carry the password hash — it gets serialised to clients.
    expect(JSON.stringify(user)).not.toContain('$argon2')
  })

  it('stores a hash, never the plaintext password', async () => {
    await auth.register('rohan@kpoint.com', 'hunter2')

    const cred = await store.findCredentialByEmail('rohan@kpoint.com')
    expect(cred).toBeDefined()
    expect(cred!.secret).not.toContain('hunter2')
    expect(cred!.secret).toMatch(/^\$argon2id\$/)
  })

  it('normalises email so case differences are the same account', async () => {
    await auth.register('Rohan@KPoint.com', 'hunter2')

    // Stored lowercased...
    const user = await store.findUserByEmail('rohan@kpoint.com')
    expect(user).toBeDefined()

    // ...and a differently-cased re-registration is a duplicate.
    await expect(auth.register('ROHAN@kpoint.com', 'other')).rejects.toThrow(AuthError)
  })

  it('trims surrounding whitespace from email', async () => {
    await auth.register('  rohan@kpoint.com  ', 'hunter2')
    expect(await store.findUserByEmail('rohan@kpoint.com')).toBeDefined()
  })

  it('rejects a duplicate registration', async () => {
    await auth.register('rohan@kpoint.com', 'hunter2')

    await expect(auth.register('rohan@kpoint.com', 'different')).rejects.toMatchObject({
      code: 'EMAIL_ALREADY_REGISTERED',
      status: 409,
    })
  })

  it('does NOT normalise the password — every byte is significant', async () => {
    await auth.register('rohan@kpoint.com', '  spaced  ')

    // Trimming a password silently changes the user's credential. Never do it.
    const ok = await auth.verifyPassword('rohan@kpoint.com', '  spaced  ')
    expect(ok).toBe(true)
    const trimmed = await auth.verifyPassword('rohan@kpoint.com', 'spaced')
    expect(trimmed).toBe(false)
  })
})

describe('verifyPassword', () => {
  beforeEach(async () => {
    await auth.register('rohan@kpoint.com', 'correct horse battery staple')
  })

  it('accepts the right password', async () => {
    expect(await auth.verifyPassword('rohan@kpoint.com', 'correct horse battery staple'))
      .toBe(true)
  })

  it('rejects the wrong password', async () => {
    expect(await auth.verifyPassword('rohan@kpoint.com', 'wrong')).toBe(false)
  })

  it('accepts a differently-cased email (same normalisation as register)', async () => {
    expect(await auth.verifyPassword('ROHAN@KPoint.com', 'correct horse battery staple'))
      .toBe(true)
  })

  it('returns false for an unknown user WITHOUT revealing that it is unknown', async () => {
    expect(await auth.verifyPassword('nobody@nowhere.com', 'whatever')).toBe(false)
  })

  it('burns comparable time on an unknown user (anti-enumeration)', async () => {
    // If a missing user returns instantly while a real user costs a full Argon2 verify,
    // an attacker times the endpoint to discover which emails exist. The fix is to hash
    // against a dummy even when there is no user.
    // → notes/module-1.../2-password-authentication (account enumeration, timing attacks)
    const t0 = performance.now()
    await auth.verifyPassword('nobody@nowhere.com', 'whatever')
    const missing = performance.now() - t0

    const t1 = performance.now()
    await auth.verifyPassword('rohan@kpoint.com', 'wrong-password')
    const existing = performance.now() - t1

    // Not asserting equality — timing is noisy. Asserting the same ORDER of magnitude,
    // i.e. the missing-user path is not a trivially fast early return.
    expect(missing).toBeGreaterThan(existing * 0.25)
  })
})
