# Session Authentication

## The problem

[4-http-authentication](../4-http-authentication/notes.md) established *how* a credential
travels (cookie vs header). It did not say **what** should travel.

The naive answer fails immediately:

```
  Set-Cookie: user_id=42          <- the user edits it to 43. Game over.
  Set-Cookie: user=rohan&admin=1  <- same, with extra steps
```

The client controls its entire request
([1-authentication-fundamentals](../1-authentication-fundamentals/notes.md)), so anything
*meaningful* in a cookie is attacker-controlled. Two escapes exist, and they define the
split between Module 1 and Module 2:

```
  Make the value MEANINGLESS      ->  a random ID, looked up server-side   [SESSIONS]
                                      the DB holds the truth

  Make the value UNFORGEABLE      ->  a signed claim, verified by crypto   [JWT, Mod 2]
                                      the signature holds the truth
```

Sessions are the first answer: **store the truth on the server, hand the client only a
pointer to it.**

## The solution: a pointer with no meaning

```
  ┌────────── SERVER (source of truth) ──────────┐
  │  sessions                                    │
  │  ┌───────────┬─────────┬──────────────────┐  │
  │  │ id        │ user_id │ expires_at       │  │
  │  ├───────────┼─────────┼──────────────────┤  │
  │  │ k7Fq2m... │ usr_01H │ 2026-09-20 14:02 │  │
  │  └───────────┴─────────┴──────────────────┘  │
  └───────────────────▲──────────────────────────┘
                      │ lookup by id
                      │
  ┌───────────────────┴──────── CLIENT ──────────┐
  │  Cookie: __Host-sid=k7Fq2m...                │
  │          (opaque — carries NO information)   │
  └──────────────────────────────────────────────┘
```

The cookie value is **opaque**: it means nothing, encodes nothing, and reveals nothing.
Editing it produces a different random string, which simply does not exist in the table.
Forgery is not "hard" — it is a lookup miss.

**Buzzword: opaque token.** A token with no internal structure the client can read or
exploit. Contrast a JWT, which is *transparent* — anyone holding it can decode the payload
(Base64 is encoding, not encryption —
[2-password-authentication](../2-password-authentication/notes.md)). Opacity is a security
property you get for free with sessions and must engineer around with JWTs.

### Session ID generation — the one thing you must not get wrong

The entire scheme rests on the ID being **unguessable**. That is a cryptographic
requirement, not a uniqueness requirement.

```
  WRONG:  Math.random()          <- not a CSPRNG; predictable from observed outputs
  WRONG:  uuid v1 / v7           <- timestamp + counter; structured, partly predictable
  WRONG:  incrementing integer   <- session 41 exists, so guess 42

  RIGHT:  crypto.randomBytes(32) <- CSPRNG, 256 bits of entropy
```

**Buzzword: CSPRNG** (Cryptographically Secure Pseudo-Random Number Generator). A
generator whose future output cannot be predicted even given many past outputs.
`Math.random()` is fast and statistically uniform but *fully predictable* once you observe
enough of its stream — fine for jitter, fatal for secrets.

**Why 256 bits:** OWASP's floor is 128. At 256 bits, guessing is not "slow" — it is
arithmetically impossible at any rate a network permits. This is the cheapest strong
decision in the entire system, so there is no reason to economise.

> **Misconception:** "UUIDs are random, so a UUID is a fine session ID." UUIDv4 is
> ~122 bits of randomness and acceptable *if* generated from a CSPRNG; UUIDv1/v7 encode a
> timestamp and are **not** suitable. The version matters more than the word "UUID". Just
> use `randomBytes` and remove the question.

## The lifecycle

```
  REGISTER/LOGIN                        EVERY REQUEST                LOGOUT
  ──────────────                        ────────────                ──────
  verify password                       read cookie                 delete row
  (Argon2id, ~250ms)                        │                           │
        │                                   ▼                           ▼
        ▼                              SELECT ... WHERE id=?       expire cookie
  CREATE session                            │                      (Max-Age=0,
  randomBytes(32)                           ▼                       same Domain
  store {id, user_id,                  found? not expired?           + Path)
         expires_at, ...}                   │
        │                                   ▼
        ▼                              req.user = session.user_id
  Set-Cookie __Host-sid                     │
                                            ▼
                                       handler runs
```

### Creation

Store more than `user_id`. The extra columns are what make Module 3's detection and
Module 5's device management possible, and retrofitting them later means a migration on
your hottest table:

```
  id           random 256-bit, PRIMARY KEY
  user_id      FK -> users
  expires_at   SERVER-side truth (the cookie's Max-Age is only UX)
  created_at   absolute-lifetime enforcement
  last_seen_at idle-timeout enforcement
  ip           \  weak signals, useful for audit and anomaly detection
  user_agent   /  never sufficient alone as an auth decision
  revoked_at   soft-delete, so "logged out at T" survives in audit
```

### Lookup

One indexed read per request. `id` is the primary key, so it is a point lookup — but it is
**still a round trip on every single authenticated request**. That cost is the whole
motivation for [7-session-storage](../7-session-storage/notes.md) and, ultimately, for
Module 2's stateless tokens.

### Expiration — two clocks, not one

```
  ABSOLUTE   created_at + 7d      "this session dies Sunday, no matter what"
                                   caps the damage window from a stolen cookie

  IDLE       last_seen_at + 30m   "inactive? gone"
                                   protects the walked-away-from-laptop case
```

Real systems enforce **both**. Idle alone lets a stolen session live forever if the
attacker keeps it warm. Absolute alone lets an abandoned session sit valid for a week.

**Trade-off:** sliding the idle window means a **write on every request** — you have
turned a read-only lookup into a read+write. Standard mitigation is to only update
`last_seen_at` when it is older than ~60s, trading precision for throughput.

**The rule, restated because it is the most-failed part:** expiry is checked
**server-side**. The cookie's `Max-Age` is a hint the user can edit
([5-cookie-security](../5-cookie-security/notes.md)).

### Logout and invalidation

```
  logout          DELETE (or set revoked_at) for THAT session id
  logout all      DELETE WHERE user_id = ?    <- the reason sessions are
                                                 strictly better than JWTs here
```

**This is stateful auth's superpower.** Revocation is a `DELETE`, effective on the very
next request. Module 2 will trade this away for scalability and spend the whole module
buying pieces of it back (short TTLs, refresh rotation, denylists).

Always clear the cookie *and* delete server-side. Clearing only the cookie leaves a live
session that any copy of the value still opens.

## Attacks the design must answer

### Session fixation

The attacker makes the victim use a session ID the **attacker already knows**.

```
  1. attacker obtains a valid pre-auth session id  S
  2. attacker plants S in the victim's browser
        (subdomain cookie tossing, or an app that accepts ?sid= from the URL)
  3. victim logs in
  4. server UPGRADES session S to authenticated   <-- THE BUG
  5. attacker uses S, now authenticated as the victim
```

**Fix — session rotation on privilege change.** Issue a *new* ID at login and destroy the
old one. The attacker's known value dies at the moment it would have gained value:

```
  login success:
      old_id = req.cookie.sid
      new_id = randomBytes(32)
      destroy(old_id);  create(new_id, user_id);  Set-Cookie new_id
```

Rotate on **every privilege change**, not just login: password change, MFA completion
(→ Module 5 step-up), role elevation. Never accept a session ID from a URL or request
body — cookie only.

### Session hijacking

The attacker **steals** a valid ID rather than planting one.

| Theft route | Structural defense | Note |
|---|---|---|
| Network sniffing | `Secure` + HTTPS everywhere | [submodule 5] |
| XSS exfiltration | `HttpOnly` | stops theft, **not** XSS → Module 3 |
| Referer leak / logs | never put the ID in a URL | — |
| Subdomain tossing | `__Host-` prefix | [submodule 5] |

**Honest limitation:** a session ID is a **bearer credential**
([4-http-authentication](../4-http-authentication/notes.md)). Once stolen, it is
indistinguishable from the real user by construction. You cannot *prevent* use — you can
only **shrink the window** (short expiry), **detect** (IP/UA anomaly, impossible travel),
and **revoke** (the `DELETE`). Binding the session to an IP sounds appealing and breaks
mobile users the moment they change networks — an availability cost most products refuse.

### Session prediction / replay

Prediction is solved outright by the CSPRNG. Replay is the hijacking case above: nothing
in the ID distinguishes a replay from a legitimate request, which is exactly why rotation,
expiry, and audit logging exist rather than a cleverer ID format.

## Limitations

- **Stateful by definition** — a storage round-trip per request, and every server needs
  access to the same session store. → [7-session-storage](../7-session-storage/notes.md).
- **Bearer credential** — theft equals impersonation, undetectable from the request alone.
  → Module 3 attacks; Module 5 passkeys remove the shared secret entirely.
- **Browser-shaped** — depends on a cookie jar. Mobile and service-to-service clients need
  bearer tokens. → Module 2.
- **The store is a hard dependency** — it goes down, *everyone* is logged out. A JWT would
  keep verifying. That availability difference is a genuine argument for stateless tokens,
  not merely a performance one.

## Interview answers

- **How does a session work?** The server verifies the password once, generates a
  256-bit CSPRNG random ID, stores `{id → user_id, expires_at}` server-side, and returns
  the ID in an `HttpOnly; Secure; SameSite` cookie. The browser attaches it automatically;
  each request is a point lookup plus a **server-side** expiry check. The cookie value is
  opaque — the server holds all the truth, so editing the cookie yields a lookup miss.
- **How does session fixation happen?** The attacker plants a session ID they already know
  in the victim's browser, and the server *upgrades that same ID* to authenticated on
  login. The fix is rotating the session ID on every privilege change, so the planted
  value is destroyed exactly when it would have become valuable.
- **JWT vs session?** Sessions store truth server-side: instant revocation, opaque tokens,
  at the cost of a lookup per request and shared-store infrastructure. JWTs carry signed
  truth in the token: no lookup, no shared state, at the cost of revocation being hard and
  the payload being readable. Sessions for browser apps you control; JWTs for distributed
  or cross-service verification. → Module 2.

---

## What implementation added

Built in `src/services/auth-service.ts` + `session-store.ts` (Sprint 1).

### `createSession` is public and separate from `login`

```ts
createSession(userId, context)          // public — no password involved
async login(email, password, context)   // calls createSession
```

`login` is *password* authentication. Module 4's Google callback will have a verified user
and **no password**, and must mint a session through the same path. Admin impersonation
later, same. Collapsing session creation into `login` means every new auth method
reimplements it — three copies, three places expiry policy must change.

### Sliding must not extend the absolute deadline

```ts
const slid: Session = { ...session, lastSeenAt: now }
//                                   ^^^ only this. expiresAt untouched.
```

If activity refreshed `expiresAt`, an active session would live forever and the absolute
cap becomes decorative. Test asserts `expiresAt` is unchanged after a slide.

### The write-avoidance threshold is a real trade

```ts
const staleness = now - session.lastSeenAt
if (staleness >= policy.slideThresholdMs) { store.update(slid) }
```

Without it every authenticated request becomes a **write** — a read-only point lookup
turned into read+write for a timestamp nobody needs to millisecond precision.

At 60s granularity a session that should idle-expire at 30:00 may survive to 30:59.
**59 seconds of imprecision bought ~99% fewer writes.** That is the trade, stated
honestly; there is no version of this that is free.

### `now` as an injected parameter

```ts
validateSession(sessionId: SessionId, now: Date = new Date())
```

Testing a 7-day timeout otherwise means waiting a week or mocking global `Date` — brittle
and it leaks across tests. Dependency injection applied to time. Production callers omit
it. This is why the expiry tests run in milliseconds.

### The secondary index is a hand-built database index

```ts
private readonly sessions = new Map<SessionId, Session>()
private readonly byUser   = new Map<UserId, Set<SessionId>>()
```

`logoutAll` without `byUser` is an O(n) scan of every session in the system. With it, a
direct lookup. **Cost:** every create and delete must update both or they drift — which is
exactly what `CREATE INDEX ON sessions(user_id)` does for you in Postgres. Building it by
hand is a good way to feel what an index actually *is*.

One bug avoided, worth noting because it is easy to hit:

```ts
for (const id of [...userSessions]) this.delete(id)
//                ^^^ copy first — delete() mutates the Set being iterated
```

### Fixation defense holds by construction

`createSession()` always mints a fresh CSPRNG id, and `login` always calls it. There is no
code path that upgrades an existing session id to authenticated — so the fixation bug
cannot be written without deliberately adding a new method. Test asserts two logins yield
different ids.

**Still missing:** rotation on *other* privilege changes — password change, MFA
completion, role elevation. Those endpoints do not exist yet; when they do, each must
rotate. → Module 5 step-up authentication.
