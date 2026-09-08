# Password Authentication

## The problem

The server must verify a password on every login, but must **not** be able to recover it —
because the database *will* eventually leak (SQL injection, stolen backup, dumped replica,
insider). Storage must survive full database compromise.

## Encoding vs encryption vs hashing

| | Reversible? | Key? | Purpose |
|---|---|---|---|
| Encoding | Yes, trivially | No | Data representation |
| Encryption | Yes, with key | Yes | Confidentiality |
| Hashing | No | No | Fingerprinting / verification |

- **Encoding** (Base64, hex, URL-encoding) — transport-safe representation. `cm9oYW4=` is
  `rohan` and anyone can reverse it. **Zero security.** Matters in Module 2: a Base64URL
  JWT payload looks scrambled but is readable by anyone holding the token.
- **Encryption** (AES, ChaCha20) — reversible with the key. Correct when you genuinely need
  the plaintext back: a user's OAuth refresh token, a TOTP secret at rest.
- **Hashing** (SHA-256, bcrypt, Argon2) — one-way; deterministic; not invertible.

## Why hash, never encrypt

Encryption implies a key. The key must live where the server can reach it, and an attacker
who takes the database usually takes the config too. **One key compromise decrypts every
password at once.**

Hashing has nothing to decrypt — the attacker must attack each password individually. And
you never *need* the plaintext: verification re-hashes the submitted password and compares.

> If a service can email you your *existing* password, they store it recoverably. Red flag.

## Salt

Without salt, identical passwords produce identical hashes:

```
alice  password123 -> ef92b778...
bob    password123 -> ef92b778...   <- same hash, visibly shared password
```

Three problems: shared passwords are visible; crack once, break many; precomputation works.

A **salt** is a unique random value per password, stored in plaintext beside the hash:

```
alice  salt=x7f2q1  hash(password123 + x7f2q1) -> 8a1c...
bob    salt=k9m4z8  hash(password123 + k9m4z8) -> 3e7f...
```

The salt is **not secret** — its job is *uniqueness*, not confidentiality. It forces
per-password attack and destroys precomputation.

Requirements: cryptographically random (`crypto.randomBytes`, never `Math.random`), >= 16
bytes, unique per password.

Modern password hashes generate and embed the salt themselves:

```
$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$RdescudvJCsgt3ub+b+dWRWJTmaaJObG
 |algorithm| |v| |--params--| |--salt--| |--------hash--------|
```

Everything needed to verify is in that one string → store a single `password_hash` column,
not separate salt/params columns. It also enables **algorithm migration**: read params from
the stored hash on login, and if below current policy, re-hash with stronger settings.

## Pepper

A secret added to every password before hashing, stored **outside** the database (env var,
KMS, HSM): `hash(password + salt + PEPPER)`.

**Defends:** attacker gets the DB but *not* application secrets — injection, leaked backup,
dumped replica. Without the pepper the stolen hashes are uncrackable.

**Limitations:** useless when the attacker gets both DB and config. Rotation is painful —
existing hashes can't be re-derived without plaintext, so you version peppers and migrate
on next login. Reasonable to defer; worth knowing as an interview differentiator.

## Attack taxonomy

These get conflated; the distinctions are precise.

| Attack | Shape | Defeated by |
|---|---|---|
| Brute force | Every combination vs one account | Password entropy + slow hashing |
| Dictionary | Likely passwords first (leaked lists, mutations) | Slow hashing + entropy rules |
| Rainbow tables | Precomputed hash→password lookup | **Salt** (fully) |
| Credential stuffing | Replay pairs leaked from *another* breach | Rate limiting, MFA, breach checks |
| Password spraying | One common password vs *many* accounts | Global/IP rate limiting, not lockout |

- **Rainbow tables** trade storage for time; salt defeats them completely, since a table
  built for unsalted hashes is useless when every user has a distinct salt. Largely
  historical now (GPUs made on-the-fly cracking cheaper) but the canonical reason salt exists.
- **Credential stuffing** is not cracking — the attacker *already has the correct password*.
  Slow hashing does nothing. This is the most common real attack on live login endpoints.
- **Password spraying** inverts the usual shape specifically to evade per-account lockout:
  5 failures on `alice` locks alice; 1 failure each across 10,000 accounts trips nothing.
  Defense requires counting failures per-IP and globally, not just per-account (Module 3).

**The pattern:** hashing defends *cracking*; rate limiting and MFA defend *replay*.
Different attack classes, different defenses — which is why Module 3 exists separately.

## Transmission

Passwords go over TLS, in the request **body**, via POST. Never in a URL query string —
URLs land in server logs, proxy logs, browser history, and `Referer` headers.

## Limitations

- Perfect storage doesn't help against stuffing, phishing, or keyloggers — the password is
  a shared secret the user reuses and can be tricked into disclosing. That ceiling is the
  reason Module 5 exists (MFA, then passkeys, which remove the shared secret entirely).

## Interview answers

- **Why hash passwords?** So a database breach doesn't yield plaintext credentials; there
  is no key whose compromise reverses them.
- **Why salt?** To make identical passwords hash differently — defeating precomputation
  (rainbow tables) and forcing the attacker to attack each password separately.
