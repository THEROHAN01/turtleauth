# Password Hashing Algorithms

## The problem

General-purpose hashes are *fast by design*. That is exactly wrong for passwords, because
the attacker inherits the same speed.

SHA-256 is a **good** hash — preimage resistant, no practical break. It is
**catastrophically wrong** for passwords, not because it is weak but because it is fast.

```
attacker has:  hash = a3f5...        (stolen from your DB)
attacker does: for candidate in wordlist:
                 if sha256(candidate) == hash: cracked
```

A modern GPU rig computes ~10 billion SHA-256/sec. Every 8-char lowercase-alphanumeric
password (36^8 ~= 2.8 trillion) falls in under five minutes. Real passwords aren't uniformly
random, so in practice far faster.

> **This is the core idea of Module 1.** The answer to "why not SHA-256 for passwords?" is
> *not* "SHA-256 is insecure" — it is **"SHA-256 is fast, and speed is the attacker's
> advantage."**

## The solution: deliberate slowness

Password hashing functions are designed to be *expensive*, with a **tunable cost**.

At 250ms per verification: invisible to a user logging in once, but caps the attacker at
~4 guesses/sec/core instead of 10 billion. **~2.5 billion× swing**, from function choice alone.

## MD5 / SHA-1 / SHA-256

- **MD5** (1991) — broken for collision resistance; trivially fast. Never for passwords.
- **SHA-1** (1995) — broken for collisions (SHAttered, 2017). Never for passwords.
- **SHA-256** — cryptographically sound, still unfit for passwords (speed).

Note the distinction: MD5/SHA-1's *collision* break matters for signatures and
certificates. Their unfitness as **password** hashes is a separate problem — speed —
which SHA-256 shares despite being unbroken. Conflating the two is the common mistake.

Fast hashes remain correct for: HMAC, signatures, file integrity, deriving keys from
already-high-entropy material.

## bcrypt (1999)

Blowfish-based, battle-tested, ubiquitous. Single cost parameter: cost 12 = 2^12 iterations;
each +1 doubles the work. Current recommendation: **cost >= 12**.

**Limitations:**
- **Silently truncates input at 72 bytes** — the tail of a long passphrase is ignored. Some
  implementations also truncate at a null byte. Mitigation: pre-hash long inputs (e.g.
  SHA-256 then base64) before bcrypt, or use a length limit deliberately.
- **CPU-hard only, not memory-hard** — GPUs parallelize it well.

## scrypt (2009)

Introduced **memory hardness**: computation requires a large block of RAM. Memory is
expensive to replicate across thousands of GPU cores, so a cheap parallel attack becomes an
expensive one.

Params: `N` (CPU/memory cost), `r` (block size), `p` (parallelism).
Available in Node's built-in `crypto` — no native build required.

## Argon2 (2015)

Winner of the Password Hashing Competition; current **OWASP first choice**.

| Variant | Memory access | Trade-off |
|---|---|---|
| Argon2d | Data-dependent | Faster; vulnerable to side-channel timing |
| Argon2i | Data-independent | Side-channel resistant; weaker vs time-memory tradeoff |
| **Argon2id** | Hybrid | **Use this one** |

Params: memory cost `m`, time cost `t`, parallelism `p`.
OWASP baseline: `m=19MiB, t=2, p=1`; stronger: `m=64MiB, t=3, p=4`.

**Limitation:** the `argon2` npm package needs a native build (node-gyp), which can
complicate slim Docker images and CI. scrypt (built-in) is the zero-dependency fallback.

## Work factor

The tunable cost that lets a hash **age gracefully**. Hardware gets faster → raise the number.

Target **200–500ms per verification on your production hardware**. Measure; don't copy
numbers from a blog.

**The tension:** too low is insecure. Too high turns the login endpoint into a
self-inflicted DoS — *every failed login burns that CPU too*, and failures are
attacker-controlled. Password hashing cost and rate limiting are coupled decisions
(Module 3).

## Verification

Never decrypts. Parse algorithm + params out of the stored hash, hash the submitted
password identically, compare.

The comparison must be **constant-time** — a naive `===` short-circuits on the first
differing byte and leaks information through timing. `argon2.verify()` and
`bcrypt.compare()` handle this internally; `crypto.timingSafeEqual` is the raw primitive.

## Migration (why we build a Hasher abstraction)

Because params are embedded in the hash string, on successful login you can check whether
the stored hash meets current policy and transparently re-hash if not:

```
verify(password, storedHash) -> ok
if needsRehash(storedHash, currentPolicy):
    store(hash(password, currentPolicy))   # only possible here — plaintext in hand
```

This is the **only** moment the plaintext exists server-side, so it is the only chance to
upgrade. Applies to raising bcrypt cost, raising Argon2 memory, or migrating bcrypt→Argon2id
across a user base without forcing a password reset.

## Decision for TurtleAuth

`Hasher` interface with **argon2id** (default) and **bcrypt** implementations, params from
config, plus `needsRehash()`. Two implementations make the theory tangible, allow
benchmarking work factors directly, and set up algorithm migration for later.

## Interview answers

- **Why not SHA-256 for passwords?** It's fast — billions/sec on a GPU. Password hashes
  must be deliberately slow and tunable.
- **bcrypt vs Argon2?** bcrypt is CPU-hard, proven, but caps input at 72 bytes and is
  GPU-parallelizable. Argon2id is memory-hard, resists GPU/ASIC far better, and is the
  current OWASP recommendation — at the cost of a native dependency.
