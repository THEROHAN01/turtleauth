/**
 * Work-factor calibration.
 *
 * The notes say: tune so verification costs 200-500ms ON YOUR PRODUCTION HARDWARE, and
 * measure rather than copying numbers from a blog. This script is that measurement.
 *
 * The tension being calibrated:
 *   too low  -> cheap for an attacker to brute-force offline
 *   too high -> your login endpoint becomes a self-inflicted DoS, because EVERY FAILED
 *               login burns that CPU too, and failures are attacker-controlled
 *               (→ Module 3 rate limiting is the other half of this decision)
 *
 * Run: pnpm bench:hash
 */
import { Argon2Hasher } from '../src/lib/hashing/argon2-hasher.js'
import { BcryptHasher } from '../src/lib/hashing/bcrypt-hasher.js'
import type { Hasher } from '../src/lib/hashing/hasher.js'

const PASSWORD = 'correct horse battery staple'
const ROUNDS = 5

async function measure(label: string, hasher: Hasher): Promise<void> {
  // Warm up: first call pays native module init and JIT, which would skew the mean.
  const warm = await hasher.hash(PASSWORD)
  await hasher.verify(PASSWORD, warm)

  const hashTimes: number[] = []
  const verifyTimes: number[] = []

  for (let i = 0; i < ROUNDS; i++) {
    const t0 = performance.now()
    const h = await hasher.hash(PASSWORD)
    hashTimes.push(performance.now() - t0)

    const t1 = performance.now()
    await hasher.verify(PASSWORD, h)
    verifyTimes.push(performance.now() - t1)
  }

  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
  const verifyMean = mean(verifyTimes)

  // The number that matters operationally: how many guesses/sec does one core give an
  // attacker who has stolen the database?
  const guessesPerSec = 1000 / verifyMean

  const verdict =
    verifyMean < 200 ? 'TOO FAST — raise it'
    : verifyMean > 500 ? 'TOO SLOW — DoS risk on failed logins'
    : 'in the 200-500ms target band'

  console.log(
    `${label.padEnd(34)} hash ${mean(hashTimes).toFixed(0).padStart(5)}ms  ` +
      `verify ${verifyMean.toFixed(0).padStart(5)}ms  ` +
      `~${guessesPerSec.toFixed(0).padStart(4)} guesses/sec/core   ${verdict}`,
  )
}

console.log(`\nnode ${process.version} · ${process.arch} · ${ROUNDS} rounds each\n`)

console.log('--- Argon2id (memory-hard; TurtleAuth default) ---')
await measure('m=19MiB t=2 p=1  (OWASP min)', new Argon2Hasher({ memoryCost: 19456, timeCost: 2, parallelism: 1 }))
await measure('m=64MiB t=3 p=4  (our default)', new Argon2Hasher({ memoryCost: 65536, timeCost: 3, parallelism: 4 }))
await measure('m=128MiB t=4 p=4 (paranoid)', new Argon2Hasher({ memoryCost: 131072, timeCost: 4, parallelism: 4 }))

console.log('\n--- bcrypt (CPU-hard only; each +1 cost doubles the work) ---')
await measure('cost=10', new BcryptHasher(10))
await measure('cost=12  (OWASP min)', new BcryptHasher(12))
await measure('cost=14', new BcryptHasher(14))

console.log(
  '\nFor scale: a GPU rig does ~10,000,000,000 SHA-256/sec.\n' +
    'That gap — billions/sec vs a handful/sec — is the entire point of a KDF.\n',
)
