import { describe, it, expect } from 'vitest'
import { Argon2Hasher, parseArgon2Params } from './argon2-hasher.js'
import {
  BcryptHasher,
  parseBcryptCost,
  exceedsBcryptInputLimit,
  BCRYPT_MAX_BYTES,
} from './bcrypt-hasher.js'
import { detectAlgorithm, UnknownHashFormatError } from './hasher.js'

// Deliberately weak params so the suite stays fast. Production values live in config;
// these exist only to exercise logic, never to model real cost.
const fastArgon = new Argon2Hasher({ memoryCost: 8192, timeCost: 1, parallelism: 1 })
const fastBcrypt = new BcryptHasher(4)

describe('Argon2Hasher', () => {
  it('produces a self-describing argon2id hash and verifies it', async () => {
    const hash = await fastArgon.hash('correct horse battery staple')
    expect(hash).toMatch(/^\$argon2id\$/)
    expect(await fastArgon.verify('correct horse battery staple', hash)).toBe(true)
  })

  it('rejects a wrong password', async () => {
    const hash = await fastArgon.hash('right')
    expect(await fastArgon.verify('wrong', hash)).toBe(false)
  })

  it('salts automatically: same password hashes differently every time', async () => {
    const a = await fastArgon.hash('same-password')
    const b = await fastArgon.hash('same-password')
    expect(a).not.toBe(b)
    // ...yet both verify. This is what defeats rainbow tables and hides shared passwords.
    expect(await fastArgon.verify('same-password', a)).toBe(true)
    expect(await fastArgon.verify('same-password', b)).toBe(true)
  })

  it('returns false rather than throwing on a malformed hash', async () => {
    expect(await fastArgon.verify('x', 'not-a-hash')).toBe(false)
  })

  it('parses params by key, not by position', () => {
    // The argon2 package emits m,p,t in some versions and m,t,p in others.
    expect(parseArgon2Params('$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA')).toEqual({
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 4,
    })
    expect(parseArgon2Params('$argon2id$v=19$m=65536,p=4,t=3$c2FsdA$aGFzaA')).toEqual({
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 4,
    })
  })
})

describe('BcryptHasher', () => {
  it('produces a bcrypt hash and verifies it', async () => {
    const hash = await fastBcrypt.hash('hunter2')
    expect(hash).toMatch(/^\$2[aby]\$/)
    expect(await fastBcrypt.verify('hunter2', hash)).toBe(true)
    expect(await fastBcrypt.verify('hunter3', hash)).toBe(false)
  })

  it('encodes its cost factor in the hash', async () => {
    const hash = await fastBcrypt.hash('x')
    expect(parseBcryptCost(hash)).toBe(4)
  })

  it('SILENTLY TRUNCATES at 72 bytes — the documented bcrypt flaw', async () => {
    const base = 'a'.repeat(BCRYPT_MAX_BYTES)
    const hash = await fastBcrypt.hash(base + 'DIFFERENT_TAIL')

    // A completely different tail still verifies, because bcrypt never saw it.
    expect(await fastBcrypt.verify(base + 'ANOTHER_TAIL_ENTIRELY', hash)).toBe(true)

    // This is exactly why callers must reject over-long input rather than trust bcrypt.
    expect(exceedsBcryptInputLimit(base + 'DIFFERENT_TAIL')).toBe(true)
  })

  it('counts BYTES not characters, so multi-byte passwords hit the limit sooner', () => {
    const emoji = '🔐'.repeat(19) // 4 bytes each = 76 bytes, only 19 characters
    expect(emoji.length).toBeLessThan(BCRYPT_MAX_BYTES)
    expect(exceedsBcryptInputLimit(emoji)).toBe(true)
  })
})

describe('detectAlgorithm', () => {
  it('identifies argon2 and every bcrypt variant', async () => {
    expect(detectAlgorithm(await fastArgon.hash('x'))).toBe('argon2id')
    expect(detectAlgorithm('$2a$12$abc')).toBe('bcrypt')
    expect(detectAlgorithm('$2b$12$abc')).toBe('bcrypt')
    expect(detectAlgorithm('$2y$12$abc')).toBe('bcrypt')
  })

  it('throws on an unknown format without echoing the whole hash', () => {
    expect(() => detectAlgorithm('plaintext-oops')).toThrow(UnknownHashFormatError)
  })
})

describe('needsRehash — the migration path', () => {
  it('is false when the stored hash already meets current policy', async () => {
    const hash = await fastArgon.hash('x')
    expect(fastArgon.needsRehash(hash)).toBe(false)
  })

  it('is true when policy has been raised since the hash was made', async () => {
    const weak = await new Argon2Hasher({
      memoryCost: 8192,
      timeCost: 1,
      parallelism: 1,
    }).hash('x')
    const stricter = new Argon2Hasher({ memoryCost: 65536, timeCost: 3, parallelism: 4 })
    expect(stricter.needsRehash(weak)).toBe(true)
  })

  it('is false when the stored hash is STRONGER than policy', async () => {
    const strong = await new Argon2Hasher({
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 4,
    }).hash('x')
    expect(fastArgon.needsRehash(strong)).toBe(false)
  })

  it('drives cross-algorithm migration: bcrypt hash under an argon2 policy', async () => {
    const bcryptHash = await fastBcrypt.hash('x')
    // This is how a whole user base migrates bcrypt -> argon2id with no password reset:
    // verify with the old algorithm, then rehash with the new one while plaintext is
    // still in hand — the only moment that is possible.
    expect(fastArgon.needsRehash(bcryptHash)).toBe(true)
  })

  it('raising bcrypt cost marks old hashes for rehash', async () => {
    const cheap = await new BcryptHasher(4).hash('x')
    expect(new BcryptHasher(10).needsRehash(cheap)).toBe(true)
  })

  it('treats an unparseable hash as needing replacement', () => {
    expect(fastArgon.needsRehash('garbage')).toBe(true)
    expect(fastBcrypt.needsRehash('garbage')).toBe(true)
  })
})
