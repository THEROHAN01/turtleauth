import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app.js'
import { Argon2Hasher } from '../lib/hashing/argon2-hasher.js'
import { DEFAULT_SESSION_POLICY } from '../services/auth-service.js'
import { createTestDb, truncateAll, type TestDb } from '../test/db.js'

/**
 * HTTP-level tests using app.inject() — Fastify's in-process request simulator.
 * No port bound, no network, no cleanup, but the FULL pipeline runs: routing, cookie
 * parsing, validation, error handler.
 */

const fastHasher = new Argon2Hasher({ memoryCost: 8192, timeCost: 1, parallelism: 1 })

let db: TestDb
let app: FastifyInstance

beforeAll(async () => {
  db = await createTestDb()
})

afterAll(async () => {
  await db.cleanup()
})

beforeEach(async () => {
  await truncateAll(db.prisma)
  // secureCookies:true so we exercise the real __Host- prefixed name.
  app = buildApp({
    hasher: fastHasher,
    secureCookies: true,
    logger: false,
    prisma: db.prisma,
  })
})

const CREDS = { email: 'rohan@kpoint.com', password: 'correct horse battery staple' }

/** Grab the raw Set-Cookie header so we can assert on the flags themselves. */
function setCookieHeader(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie']
  return Array.isArray(raw) ? raw.join('; ') : String(raw ?? '')
}

async function registerAndGetCookie(): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/auth/register', payload: CREDS })
  const cookie = res.cookies[0]
  return `${cookie!.name}=${cookie!.value}`
}

describe('POST /auth/register', () => {
  it('creates a user and returns 201', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/register', payload: CREDS })

    expect(res.statusCode).toBe(201)
    expect(res.json().user.email).toBe('rohan@kpoint.com')
    expect(res.json().user.emailVerified).toBe(false)
  })

  it('NEVER returns the password hash', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/register', payload: CREDS })

    expect(res.body).not.toContain('$argon2')
    expect(res.json().user).not.toHaveProperty('password')
    expect(res.json().user).not.toHaveProperty('secret')
  })

  it('sets a session cookie with EVERY security flag', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/register', payload: CREDS })
    const header = setCookieHeader(res)

    expect(header).toContain('__Host-sid=')   // prefix: browser enforces host-only
    expect(header).toContain('HttpOnly')       // JS cannot read it
    expect(header).toContain('Secure')         // HTTPS only
    expect(header).toContain('SameSite=Lax')   // cross-site POST blocked
    expect(header).toContain('Path=/')         // required by __Host-

    // __Host- REQUIRES no Domain attribute. A Domain here means the browser rejects
    // the cookie outright and the user silently cannot log in.
    expect(header).not.toContain('Domain=')
  })

  it('rejects a duplicate email with 409', async () => {
    await app.inject({ method: 'POST', url: '/auth/register', payload: CREDS })
    const res = await app.inject({ method: 'POST', url: '/auth/register', payload: CREDS })

    expect(res.statusCode).toBe(409)
  })

  it('rejects a malformed email with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'not-an-email', password: 'long enough password' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejects a short password with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'a@b.com', password: 'short' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejects an over-long password before it reaches the hasher (DoS guard)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'a@b.com', password: 'x'.repeat(5000) },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('POST /auth/login', () => {
  beforeEach(async () => {
    await app.inject({ method: 'POST', url: '/auth/register', payload: CREDS })
  })

  it('returns 200 and a session cookie on correct credentials', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/login', payload: CREDS })

    expect(res.statusCode).toBe(200)
    expect(res.json().user.email).toBe('rohan@kpoint.com')
    expect(setCookieHeader(res)).toContain('__Host-sid=')
  })

  it('gives an IDENTICAL response for wrong password and unknown user', async () => {
    const wrongPassword = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { ...CREDS, password: 'wrong but long enough' },
    })
    const unknownUser = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'ghost@nowhere.com', password: 'wrong but long enough' },
    })

    // Same status AND same body: nothing reveals which emails are registered.
    expect(wrongPassword.statusCode).toBe(401)
    expect(unknownUser.statusCode).toBe(401)
    expect(wrongPassword.body).toBe(unknownUser.body)
  })

  it('returns 401 (not 400) for malformed input — one failure shape only', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'garbage', password: 'x' },
    })

    // A 400 here would be an oracle: "that email is malformed" vs "wrong credentials".
    expect(res.statusCode).toBe(401)
  })

  it('issues a NEW session id on each login (session fixation defense)', async () => {
    const first = await app.inject({ method: 'POST', url: '/auth/login', payload: CREDS })
    const second = await app.inject({ method: 'POST', url: '/auth/login', payload: CREDS })

    expect(first.cookies[0]!.value).not.toBe(second.cookies[0]!.value)
  })
})

describe('GET /auth/me', () => {
  it('returns the user when the cookie is valid', async () => {
    const cookie = await registerAndGetCookie()

    const res = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().user.email).toBe('rohan@kpoint.com')
  })

  it('returns 401 with no cookie at all', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/me' })
    expect(res.statusCode).toBe(401)
  })

  it('returns 401 for a forged session id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie: '__Host-sid=totally-made-up-value' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('never leaks internal detail in the error body', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie: '__Host-sid=forged' },
    })

    expect(res.json().message).toBe('Not authenticated.')
    expect(res.body).not.toContain('no such session')
  })

  it('rejects an expired session — server-side clock, not the cookie', async () => {
    // A 1ms-lifetime policy: the cookie's Max-Age is irrelevant to this decision.
    const shortLived = buildApp({
      hasher: fastHasher,
      secureCookies: true,
      logger: false,
      prisma: db.prisma,
      sessionPolicy: { ...DEFAULT_SESSION_POLICY, absoluteLifetimeMs: 1 },
    })

    const reg = await shortLived.inject({
      method: 'POST',
      url: '/auth/register',
      payload: CREDS,
    })
    const cookie = `${reg.cookies[0]!.name}=${reg.cookies[0]!.value}`

    await new Promise((r) => setTimeout(r, 10))

    const res = await shortLived.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie },
    })
    expect(res.statusCode).toBe(401)
  })
})

describe('POST /auth/logout', () => {
  it('invalidates the session server-side', async () => {
    const cookie = await registerAndGetCookie()

    const before = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } })
    expect(before.statusCode).toBe(200)

    await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie } })

    // Replaying the SAME cookie must now fail — proving the server forgot it, rather
    // than merely asking the browser to drop it.
    const after = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } })
    expect(after.statusCode).toBe(401)
  })

  it('clears the cookie with matching attributes', async () => {
    const cookie = await registerAndGetCookie()
    const res = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie },
    })

    const header = setCookieHeader(res)
    expect(header).toContain('__Host-sid=')
    // Max-Age=0 tells the browser to delete it. Path must match the original or the
    // browser creates a second cookie instead of removing the first.
    expect(header).toContain('Max-Age=0')
    expect(header).toContain('Path=/')
  })

  it('returns 204 even with no session — nothing to reveal', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/logout' })
    expect(res.statusCode).toBe(204)
  })
})

describe('POST /auth/logout-all', () => {
  it('ends every session for the user', async () => {
    await app.inject({ method: 'POST', url: '/auth/register', payload: CREDS })

    const phone = await app.inject({ method: 'POST', url: '/auth/login', payload: CREDS })
    const laptop = await app.inject({ method: 'POST', url: '/auth/login', payload: CREDS })
    const phoneCookie = `${phone.cookies[0]!.name}=${phone.cookies[0]!.value}`
    const laptopCookie = `${laptop.cookies[0]!.name}=${laptop.cookies[0]!.value}`

    const res = await app.inject({
      method: 'POST',
      url: '/auth/logout-all',
      headers: { cookie: phoneCookie },
    })
    expect(res.statusCode).toBe(200)

    // Both devices are out, including the one that did not make the request.
    for (const cookie of [phoneCookie, laptopCookie]) {
      const check = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } })
      expect(check.statusCode).toBe(401)
    }
  })

  it('requires authentication', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/logout-all' })
    expect(res.statusCode).toBe(401)
  })
})

describe('full lifecycle', () => {
  it('register -> me -> logout -> login -> me', async () => {
    const reg = await app.inject({ method: 'POST', url: '/auth/register', payload: CREDS })
    expect(reg.statusCode).toBe(201)
    const c1 = `${reg.cookies[0]!.name}=${reg.cookies[0]!.value}`

    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: c1 } })).statusCode).toBe(200)

    await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie: c1 } })
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: c1 } })).statusCode).toBe(401)

    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: CREDS })
    const c2 = `${login.cookies[0]!.name}=${login.cookies[0]!.value}`
    expect(c2).not.toBe(c1)

    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: c2 } })).statusCode).toBe(200)
  })
})
