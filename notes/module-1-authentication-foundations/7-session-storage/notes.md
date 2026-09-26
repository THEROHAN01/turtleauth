# Session Storage

## The problem

[6-session-authentication](../6-session-authentication/notes.md) ends with a hard
requirement: **every authenticated request performs a session lookup.**

That single sentence has two consequences that shape your entire infrastructure:

```
  1. LATENCY   the lookup sits in the critical path of EVERY request
               (not just login — every single authenticated call)

  2. SHARING   whichever machine handles the request must reach the SAME store
               the moment there is more than one machine
```

Storage choice is therefore not a detail. It decides how the service scales, what happens
when a node dies, and whether a deploy logs everyone out.

## Why one server is a lie

```
   ONE SERVER (works, briefly)              MANY SERVERS (reality)

   Client ──► Server A                      Client ──► Load Balancer
              [sessions in RAM]                            │
                   ✓ found                        ┌────────┼────────┐
                                                  ▼        ▼        ▼
                                              Server A  Server B  Server C
                                              [RAM: S]  [RAM: -]  [RAM: -]
                                                  ✓        ✗ 401     ✗ 401
                                                        randomly logged out
```

**Buzzword: horizontal scaling.** Adding *more machines* (scale out) rather than a bigger
machine (scale up / vertical). It is how anything survives load and node failure — and it
is precisely what in-memory session state breaks.

The deeper principle:

> **Session state in process memory makes your servers *stateful*, and stateful servers
> cannot be freely added, removed, or restarted.** Every deploy becomes a mass logout.

## The three options

### 1. In-memory (a `Map` in the process)

```
  const sessions = new Map()      // id -> {userId, expiresAt}
```

| | |
|---|---|
| **Speed** | Fastest possible — no network, no serialization (~microseconds) |
| **Survives restart** | **No.** Deploy = everyone logged out |
| **Multi-server** | **No.** Each process has a different view |
| **Use case** | Local dev, tests, single-process tools. **Never production.** |

Worth building first anyway: it makes the *interface* obvious before infrastructure
muddies it, and it is the baseline the other two are measured against.

### 2. Database (PostgreSQL, a `sessions` table)

```
  SELECT user_id, expires_at FROM sessions WHERE id = $1
```

| | |
|---|---|
| **Speed** | ~1–5ms — indexed point lookup on a primary key |
| **Survives restart** | Yes — durable on disk |
| **Multi-server** | Yes — all nodes query the same DB |
| **Cost** | **Adds DB load to every authenticated request** |

The real trade-off: your database is usually the hardest thing to scale, and you have just
put a mandatory read in front of *every* request. It also needs a **reaper** — expired
rows do not remove themselves:

```
  DELETE FROM sessions WHERE expires_at < now();   -- cron / pg_cron / job
```

Forget this and the table grows forever, degrading the index that made it fast.

**Use case:** genuinely fine at small-to-moderate scale, and it buys real things — SQL
joins for "list my active devices", transactional consistency with the `users` row, and
one less piece of infrastructure. Do not let anyone tell you it is wrong by default;
premature Redis is its own failure mode.

### 3. Redis (in-memory key-value store, over the network)

```
  SETEX  session:k7Fq2m...  604800  '{"userId":"usr_01H"}'
  GET    session:k7Fq2m...
```

| | |
|---|---|
| **Speed** | ~0.1–1ms — RAM-resident, but a network hop |
| **Survives restart** | Configurable (RDB/AOF persistence) — **not free, not default-durable** |
| **Multi-server** | Yes — the shared store all nodes reach |
| **Killer feature** | **Native TTL: expiry is the datastore's job** |

```
  SETEX key 604800 value    ──►  Redis deletes it automatically at expiry
                                 no reaper job, no cleanup cron, no bloat
```

That is the decisive advantage over Postgres for this specific workload: session data is
**ephemeral, high-churn, and key-value shaped** — exactly Redis's design center, and
exactly the shape relational durability guarantees are wasted on.

**Honest costs:** another service to run, monitor, and secure. Redis persistence is
tunable but weaker than Postgres — an unlucky crash can lose recent sessions (users
re-login; acceptable for sessions, unacceptable for orders). And it becomes a **new single
point of failure** unless you run Sentinel/Cluster.

### Decision table

| | In-memory | PostgreSQL | Redis |
|---|---|---|---|
| Latency | ~µs | ~1–5ms | ~0.1–1ms |
| Survives restart | ✗ | ✓ | ✓ (configurable) |
| Multi-server | ✗ | ✓ | ✓ |
| Auto-expiry | manual | **manual reaper** | **native TTL** |
| Queryable (`WHERE user_id`) | ✗ | **✓ SQL** | ✗ (needs a secondary index) |
| Extra infrastructure | none | none (already there) | **+1 service** |

**Decision for TurtleAuth:** build the in-memory store first to fix the interface, ship
Postgres for Module 1 (the `sessions` table is on the Module 6 schema anyway, and joins
make "list my devices" trivial), then introduce Redis in Module 3 — where distributed rate
limiting needs it regardless, so its operational cost is already paid.

## Stateful vs stateless — the actual definition

This pair is used loosely everywhere. Precisely:

```
  STATEFUL                                  STATELESS
  the server must LOOK SOMETHING UP         the request CARRIES its own proof

  Cookie: sid=k7Fq...                       Authorization: Bearer eyJhbGci...
        │                                          │
        ▼                                          ▼
  ┌───────────┐                             verify signature with a public key
  │   store   │  <- shared dependency       (no store, no network, ~50µs)
  └───────────┘                                    │
        │                                          ▼
        ▼                                   trust the claims inside
  truth lives in the store                  truth lives in the signature
```

| | Stateful (sessions) | Stateless (JWT) |
|---|---|---|
| Per-request cost | network/disk lookup | CPU-only signature check |
| **Revocation** | **instant — `DELETE`** | **hard — valid until expiry** |
| Shared infrastructure | required | none |
| Token readable by holder | no (opaque) | **yes** (Base64, not encryption) |
| Store outage | everyone logged out | keeps working |

> **The trade is revocation ⇄ scalability, and it is not resolvable — only positioned.**
> Module 2 chooses stateless and then spends the entire module buying revocation back
> (short access-token TTL, refresh rotation, reuse detection, denylists). Note what a
> denylist actually is: *reintroducing state*. The honest end state is a hybrid —
> stateless for the 15-minute access token, stateful for the long-lived refresh token.

**Misconception:** "stateless means no database." It means no *session* lookup. You still
hit the DB for user data, permissions, and everything else. The saving is narrower than
the marketing implies.

## Scaling patterns

### Sticky sessions (session affinity)

**Buzzword:** the load balancer pins each client to the same backend (by cookie or IP
hash), so in-memory state keeps working.

```
  Client A ──► LB ══pinned══► Server A  [has A's session in RAM]
  Client B ──► LB ══pinned══► Server B  [has B's session in RAM]
```

**Why it is a trap, not a solution:**

- Server A dies → **all** its users are logged out (state was only there).
- Load distributes by *assignment*, not by *actual load* — hot nodes stay hot.
- Autoscaling and rolling deploys fight it constantly.
- You cannot drain a node for maintenance without dropping sessions.

It treats the symptom (needing shared state) by constraining routing. Legitimate as a
legacy-migration step; not a target architecture.

### Distributed sessions (the real answer)

Move state **out** of the app processes into a shared store. Servers become
**stateless-with-respect-to-sessions** — identical, disposable, freely scaled.

```
  Client ──► Load Balancer ──► any Server (A | B | C)   <- interchangeable
                                     │
                                     ▼
                            ┌─────────────────┐
                            │  Redis / Postgres│        <- the only stateful part
                            └─────────────────┘
```

Now: any node serves any request, deploys do not log anyone out, autoscaling works, node
death is invisible to users.

**The cost, stated plainly:** you did not eliminate the stateful component — you
**centralised** it. The shared store is now on the critical path of every authenticated
request and is a single point of failure. That is why it must be replicated
(Redis Sentinel/Cluster, Postgres replicas) and why its latency is now *your* latency.
Centralising state is the trade; it is a better trade than sticky sessions, not a free
lunch.

## Where this lands

```
  in-memory  ──► can't scale, can't restart
       │
       ▼
  shared store (Postgres / Redis)  ──► scales, but a lookup per request
       │                                and a hard dependency
       ▼
  stateless tokens (Module 2)      ──► no lookup, no dependency
                                        but revocation becomes the problem
       │
       ▼
  hybrid (the production answer)   ──► stateless short-lived access token
                                     + stateful refresh token
```

## Limitations

- **The shared store is a new SPOF** on the critical path — needs replication, monitoring,
  and a considered failure mode (fail closed and log everyone out, or fail open and accept
  unverified requests? Almost always: fail closed).
- **Latency is now network latency.** A lookup that was microseconds is now a hop; a slow
  or saturated store degrades every authenticated request in the system.
- **Redis is not durable by default** — tune persistence deliberately, and accept that
  sessions are the *right* data to risk losing.
- **Postgres sessions need a reaper**; forgetting it is a slow, quiet degradation.
- **None of this helps non-browser clients** — still cookie-shaped. → Module 2.

## Interview answers

- **How do sessions scale?** Move session state out of process memory into a shared store
  (Redis or Postgres) so every app server is interchangeable. Sticky sessions are the
  alternative, but they pin users to nodes — node death logs those users out and
  autoscaling fights the affinity. Distributed sessions centralise the stateful part,
  which then needs replication because it sits on every request's critical path.
- **Stateful vs stateless authentication?** Stateful means the server looks the credential
  up (instant revocation, shared-store dependency, one round trip per request). Stateless
  means the request carries its own cryptographic proof (no lookup, no shared state, but
  revocation is hard and the payload is readable). The trade is revocation against
  scalability; production systems usually run both — stateless short-lived access tokens
  plus a stateful refresh token.

---

## What implementation added

Built in `src/services/session-store.ts` (Sprint 1) — the in-memory tier only. Postgres
is Sprint 2.

### The failure mode is visible at startup, deliberately

```ts
app.log.warn(
  'Sessions are IN-MEMORY: a restart logs everyone out, and a second instance ' +
  'would not see these sessions.'
)
```

A limitation nobody is reminded of becomes a production incident. Printing it every boot
in non-production costs one log line and makes the constraint impossible to forget between
now and Sprint 2.

### `update()` refuses to resurrect

```ts
update(session: Session): void {
  if (!this.sessions.has(session.id)) return   // never revive a deleted session
  this.sessions.set(session.id, session)
}
```

Without the guard, a slid `lastSeenAt` write racing a concurrent `logout` would re-insert
the session that logout just removed. Node is single-threaded so the two cannot interleave
*inside* one tick — but `validateSession` holds a session object across an `await` in real
handlers, and the check costs nothing. Postgres will need this as a `WHERE id = ?` on the
UPDATE rather than an upsert, for the same reason.

### Empty-Set cleanup

```ts
if (userSessions.size === 0) this.byUser.delete(session.userId)
```

Without it `byUser` accumulates an empty `Set` per user who ever logged out — a slow leak
invisible to every test. The Postgres equivalent is that rows genuinely disappear;
hand-built indexes need hand-built cleanup.

### What Postgres has to answer (Sprint 2)

| Question | Map answer | Postgres must |
|---|---|---|
| Find by id | `Map.get` | PK point lookup |
| All for user | `byUser` Set | index on `user_id` |
| Expired rows | never removed | **reaper** — `DELETE WHERE expires_at < now()` |
| Survives restart | no | yes |
| Two instances agree | no | yes |

The reaper is the one with no in-memory analogue and no reminder: expired sessions are
already rejected by `validateSession`, so a missing reaper produces **no functional bug**
— just a table that grows forever until the index degrades. Silent, slow, and only
noticed under load.

---

## What Postgres added (v0.1.1)

The in-memory tier is gone. `src/services/session-store.ts` is now `PostgresSessionStore`.

### Verified, not assumed

```
  register  ->  cookie issued by process A
  kill -9 A
  start process B  (new PID, empty memory)
  same cookie  ->  200, same user id
```

On `v0.1.0` that cookie returned 401 and the account itself was gone. This is the entire
point of the increment, and it is the one thing worth testing by hand rather than trusting
a unit test.

### The hand-built index, replaced

```
  in-memory:  byUser: Map<UserId, Set<SessionId>>   maintained by hand on every
                                                     create and delete, or it drifts
  Postgres:   @@index([userId])                      maintained by the database
```

Both `logoutAll` implementations are one operation. The difference is who guarantees the
index is correct. Building it by hand first is what makes `CREATE INDEX` stop being
magic — it is that Set, kept in sync for you.

### `update` vs `updateMany` — a durability-only problem

```ts
// update() THROWS when the row is gone
await prisma.session.updateMany({ where: { id }, data: { lastSeenAt } })
```

A session can legitimately vanish between `validateSession` reading it and the slide
writing it back — a logout in another tab, or the reaper once it exists. `updateMany`
affects zero rows and returns quietly.

This is the in-memory `if (!sessions.has(id)) return` guard, restated in SQL. In memory it
was defensive; with a shared database and concurrent instances it is load-bearing.

### Two clients, one connection, different schemas

Prisma's **generated client hardcodes the schema name from `schema.prisma`** into its SQL.
It ignores the connection's `search_path`. Raw queries (`$queryRawUnsafe`) honour it.

```
  connection search_path = "test_abc",public

  prisma.user.create()          -> writes to public      (baked in)
  $queryRawUnsafe('...users')   -> reads  test_abc       (search_path)
```

Setup and assertions read one schema while the code under test writes another. The visible
symptom was a brand-new empty schema reporting `EMAIL_ALREADY_REGISTERED` — which reads
like a logic bug and is actually a targeting bug.

Worth knowing beyond tests: any multi-tenant-by-schema design on Prisma hits this. Schema
isolation needs a client per schema, not a connection setting.

### Constraints move from accident to guarantee

```
  in-memory:  if (emailIndex.has(email)) return null   atomic by ACCIDENT
                                                        (single-threaded JS)
  Postgres:   UNIQUE INDEX + catch P2002                atomic by GUARANTEE
```

Check-then-insert has a real race against a database: two concurrent registrations both
SELECT "not found", then both INSERT. Catching the constraint violation is not error
handling — it is **how the application learns the database refused**.

General principle: a check the application performs is an optimisation; only the database
can be the arbiter.

### What Postgres did NOT give us

Expired rows still accumulate. `validateSession` deletes any it encounters, so the only
rows that linger are those nobody touches again — which is most of them.

No test fails. No user sees an error. The table grows until the index degrades, months
later, under load. The in-memory version got cleanup for free from process restarts;
durability removes that accident and makes the requirement explicit for the first time.

→ [issue #1](https://github.com/THEROHAN01/turtleauth/issues/1), deliberately deferred.
