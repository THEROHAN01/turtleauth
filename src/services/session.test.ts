import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import { AuthService, DEFAULT_SESSION_POLICY, type SessionPolicy } from './auth-service.js'
import { PostgresUserStore } from './user-store.js'
import { PostgresSessionStore } from './session-store.js'
import { Argon2Hasher } from '../lib/hashing/argon2-hasher.js'
import { asSessionId, type User } from '../core/types.js'
import { createTestDb, truncateAll, type TestDb } from '../test/db.js'

const hasher = new Argon2Hasher({ memoryCost: 8192, timeCost: 1, parallelism: 1 })

let db: TestDb
let store: PostgresUserStore
let sessions: PostgresSessionStore
let auth: AuthService
let user: User

beforeAll(async () => {
  db = await createTestDb()
  store = new PostgresUserStore(db.prisma)
  sessions = new PostgresSessionStore(db.prisma)
})

afterAll(async () => {
  await db.cleanup()
})

async function setup(policy: SessionPolicy = DEFAULT_SESSION_POLICY) {
  await truncateAll(db.prisma)
  auth = new AuthService(store, hasher, sessions, policy)
  user = await auth.register('rohan@kpoint.com', 'correct horse battery staple')
}

beforeEach(() => setup())

describe('createSession', () => {
  it('generates an unguessable id, not a sequential or structured one', async () => {
    const a = await auth.createSession(user.id)
    const b = await auth.createSession(user.id)

    expect(a.id).not.toBe(b.id)
    // 32 random bytes in base64url ≈ 43 chars. The point is high entropy, not the
    // exact length — assert it is nowhere near short enough to brute force.
    expect(a.id.length).toBeGreaterThanOrEqual(40)
    // base64url alphabet only: no +, /, or = padding, so it is cookie-safe as-is.
    expect(a.id).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('sets the absolute deadline from policy', async () => {
    const before = Date.now()
    const session = await auth.createSession(user.id)
    const expected = before + DEFAULT_SESSION_POLICY.absoluteLifetimeMs

    // Within a second of expected — allows for execution time.
    expect(Math.abs(session.expiresAt.getTime() - expected)).toBeLessThan(1000)
  })

  it('records context for audit but never as an auth decision', async () => {
    const session = await auth.createSession(user.id, {
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0',
    })
    expect(session.ip).toBe('203.0.113.7')
    expect(session.userAgent).toBe('Mozilla/5.0')
  })

  it('defaults context to null when not supplied', async () => {
    const session = await auth.createSession(user.id)
    expect(session.ip).toBeNull()
    expect(session.userAgent).toBeNull()
  })
})

describe('login', () => {
  it('returns a session and the user on correct credentials', async () => {
    const { session, user: u } = await auth.login(
      'rohan@kpoint.com',
      'correct horse battery staple',
    )
    expect(session.userId).toBe(user.id)
    expect(u.email).toBe('rohan@kpoint.com')
  })

  it('normalises email the same way register does', async () => {
    const { user: u } = await auth.login(
      '  ROHAN@KPoint.com  ',
      'correct horse battery staple',
    )
    expect(u.id).toBe(user.id)
  })

  it('throws the SAME error for wrong password and unknown user', async () => {
    const wrongPassword = await auth
      .login('rohan@kpoint.com', 'nope')
      .catch((e) => e)
    const noSuchUser = await auth
      .login('ghost@nowhere.com', 'nope')
      .catch((e) => e)

    // Identical code, status, and client-facing message: nothing distinguishes them.
    expect(wrongPassword.code).toBe('INVALID_CREDENTIALS')
    expect(noSuchUser.code).toBe('INVALID_CREDENTIALS')
    expect(wrongPassword.publicMessage).toBe(noSuchUser.publicMessage)
    expect(wrongPassword.status).toBe(401)
  })

  it('issues a DIFFERENT session id on every login (no fixation)', async () => {
    const a = await auth.login('rohan@kpoint.com', 'correct horse battery staple')
    const b = await auth.login('rohan@kpoint.com', 'correct horse battery staple')
    expect(a.session.id).not.toBe(b.session.id)
  })
})

describe('validateSession', () => {
  it('accepts a live session and returns its user', async () => {
    const session = await auth.createSession(user.id)
    const result = await auth.validateSession(session.id)
    expect(result.user.id).toBe(user.id)
  })

  it('rejects an id that never existed', async () => {
    await expect(auth.validateSession(asSessionId('totally-made-up'))).rejects.toThrow()
  })

  it('gives the same error for a forged id as for an expired one', async () => {
    const session = await auth.createSession(user.id)
    const past = new Date(Date.now() + DEFAULT_SESSION_POLICY.absoluteLifetimeMs + 1)

    const forged = await auth.validateSession(asSessionId('forged')).catch((e) => e as any)
    const expired = await auth.validateSession(session.id, past).catch((e) => e as any)

    // Different internal codes are fine; what the CLIENT sees must be identical.
    expect(forged.publicMessage).toBe(expired.publicMessage)
    expect(forged.status).toBe(expired.status)
  })

  it('enforces the ABSOLUTE deadline even on a constantly-active session', async () => {
    const session = await auth.createSession(user.id)
    // Just past the absolute cap. lastSeenAt is irrelevant here — that is the point.
    const past = new Date(session.expiresAt.getTime() + 1)
    await expect(auth.validateSession(session.id, past)).rejects.toThrow()
  })

  it('enforces the IDLE timeout well before the absolute deadline', async () => {
    const session = await auth.createSession(user.id)
    const idle = new Date(Date.now() + DEFAULT_SESSION_POLICY.idleTimeoutMs + 1000)

    // Still far inside the 7-day absolute window...
    expect(idle.getTime()).toBeLessThan(session.expiresAt.getTime())
    // ...but idle-expired, so rejected.
    await expect(auth.validateSession(session.id, idle)).rejects.toThrow()
  })

  it('deletes an expired session rather than leaving it to rot', async () => {
    const session = await auth.createSession(user.id)
    expect(await sessions.size()).toBe(1)

    const past = new Date(session.expiresAt.getTime() + 1)
    await expect(auth.validateSession(session.id, past)).rejects.toThrow()
    expect(await sessions.size()).toBe(0)
  })

  it('slides lastSeenAt once the staleness threshold is crossed', async () => {
    const session = await auth.createSession(user.id)
    const later = new Date(Date.now() + DEFAULT_SESSION_POLICY.slideThresholdMs + 1000)

    const result = await auth.validateSession(session.id, later)
    expect(result.session.lastSeenAt.getTime()).toBe(later.getTime())
    // Persisted, not just returned.
    const stored = await sessions.findById(session.id)
    expect(stored!.lastSeenAt.getTime()).toBe(later.getTime())
  })

  it('does NOT write on every request — below threshold it leaves the record alone', async () => {
    const session = await auth.createSession(user.id)
    const before = await sessions.findById(session.id)
    const original = before!.lastSeenAt.getTime()

    // 1 second later, under the 60s threshold.
    await auth.validateSession(session.id, new Date(Date.now() + 1000))

    const after = await sessions.findById(session.id)
    expect(after!.lastSeenAt.getTime()).toBe(original)
  })

  it('sliding the idle window does NOT extend the absolute deadline', async () => {
    const session = await auth.createSession(user.id)
    const originalExpiry = session.expiresAt.getTime()

    const later = new Date(Date.now() + DEFAULT_SESSION_POLICY.slideThresholdMs + 1000)
    const result = await auth.validateSession(session.id, later)

    // The absolute cap is absolute: activity refreshes idle, never the hard deadline.
    expect(result.session.expiresAt.getTime()).toBe(originalExpiry)
  })

  it('rejects a session whose user has been deleted', async () => {
    const session = await auth.createSession(user.id)
    // Simulate the user row disappearing under a live session. ON DELETE CASCADE
    // removes the session too, which is itself the correct behaviour — either way the
    // session must not validate.
    await db.prisma.user.delete({ where: { id: user.id } })
    await expect(auth.validateSession(session.id)).rejects.toThrow()
  })
})

describe('logout', () => {
  it('invalidates the session immediately', async () => {
    const { session } = await auth.login(
      'rohan@kpoint.com',
      'correct horse battery staple',
    )
    await expect(auth.validateSession(session.id)).resolves.toBeDefined()

    await auth.logout(session.id)
    await expect(auth.validateSession(session.id)).rejects.toThrow()
  })

  it('is idempotent — logging out twice is not an error', async () => {
    const session = await auth.createSession(user.id)
    await auth.logout(session.id)
    await expect(auth.logout(session.id)).resolves.toBeUndefined()
  })

  it('only ends the session it was given, not the user other devices', async () => {
    const phone = await auth.createSession(user.id)
    const laptop = await auth.createSession(user.id)

    await auth.logout(phone.id)

    await expect(auth.validateSession(phone.id)).rejects.toThrow()
    await expect(auth.validateSession(laptop.id)).resolves.toBeDefined()
  })
})

describe('logoutAll', () => {
  it('ends every session for the user and reports how many', async () => {
    await auth.createSession(user.id)
    await auth.createSession(user.id)
    await auth.createSession(user.id)

    expect(await auth.logoutAll(user.id)).toBe(3)
    expect(await sessions.size()).toBe(0)
  })

  it('leaves other users signed in', async () => {
    const other = await auth.register('other@kpoint.com', 'another password entirely')
    const mine = await auth.createSession(user.id)
    const theirs = await auth.createSession(other.id)

    await auth.logoutAll(user.id)

    await expect(auth.validateSession(mine.id)).rejects.toThrow()
    await expect(auth.validateSession(theirs.id)).resolves.toBeDefined()
  })

  it('returns 0 for a user with no sessions', async () => {
    expect(await auth.logoutAll(user.id)).toBe(0)
  })
})
