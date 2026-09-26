# Sprint 1 — Authentication Foundations

Shipped `v0.1.0` (password auth + in-memory sessions) and `v0.1.1` (Postgres).
Six things went wrong. Two were genuinely expensive.

---

## 1. pnpm blocked the native builds, silently

**Symptom**

```
pnpm add argon2 bcrypt
...
Ignored build scripts: argon2, bcrypt.
```

Install "succeeded". Neither package would have loaded.

**What we assumed**

Nothing yet — this one announced itself. Worth recording because the *reason* matters.

**Root cause**

Both are native C++ addons that compile at install time via `node-gyp`. pnpm refuses to
run install scripts unless explicitly allowed: a package's install script is arbitrary
code execution on your machine, triggered by typing `pnpm add`.

**Fix**

```json
"pnpm": { "onlyBuiltDependencies": ["argon2", "bcrypt"] }
```
then `pnpm rebuild argon2 bcrypt`.

**Lesson**

The notes listed "needs a native build" as Argon2's cost in the abstract. This is what
that cost actually looks like: an extra config entry, and a supply-chain decision you are
now on record as having made deliberately.

Verified the modules actually loaded (`node -e "require('argon2')..."`) **before** writing
code on top of them. A package that installs is not a package that works.

**Cost** — 5 minutes.

---

## 2. `latest` pointed at a release candidate

**Symptom**

```
prisma: 8.0.0-rc.17   |   @prisma/client: ^7.10.0
```

CLI and client on different major versions.

**What we assumed**

That `pnpm add prisma @prisma/client` gives matching stable versions. It normally does.

**Root cause**

npm's `dist-tags` for `prisma` currently have `latest` → `8.0.0-rc.17` and `prev` →
`7.10.0`. The RC is tagged latest, so a plain install takes it.

```
$ npm view prisma dist-tags
  next:   8.0.0-rc.10
  prev:   7.10.0          <- the actual stable release
  latest: 8.0.0-rc.17     <- what `pnpm add prisma` resolves to
```

**Fix**

Pinned both to `7.10.0` explicitly.

**Lesson**

`latest` is a mutable pointer a maintainer sets, not a guarantee of stability. For
anything load-bearing — and a password database is load-bearing — check `dist-tags`
rather than trusting the default.

The mismatch was visible in `package.json` immediately. Reading what an install actually
wrote, rather than trusting that it worked, is what caught it.

**Cost** — 10 minutes, including the re-install.

---

## 3. Prisma 7 moved the connection URL

**Symptom**

```
Error code: P1012
The datasource property `url` is no longer supported in schema files.
```

Then, after fixing that:

```
The `extensions` property is only available with the `postgresqlExtensions`
preview feature.
```

**What we assumed**

That the roadmap's Prisma workflow (`url = env("DATABASE_URL")` in `schema.prisma`) still
applied. It is what every tutorial shows.

**Root cause**

Prisma 7 split configuration:

| | Prisma 6 and earlier | Prisma 7 |
|---|---|---|
| Connection URL | `url` in `schema.prisma` | `prisma.config.ts` |
| Runtime | bundled query engine | `@prisma/adapter-pg` over a `pg` pool |

**Fix**

`prisma.config.ts` with `datasource.url`, `@prisma/adapter-pg` at runtime, and
`previewFeatures = ["postgresqlExtensions"]` for the citext declaration.

**Lesson**

The net change is an improvement: `schema.prisma` is now environment-agnostic and
**cannot carry a connection string into version control**, and the connection pool is
ours to size rather than the engine's.

Both errors named the fix precisely. Reading the error text rather than searching for the
symptom was the whole debugging strategy here.

**Cost** — 10 minutes.

---

## 4. Prisma ignores `search_path` — the expensive one

**Symptom**

Every test failed with `EMAIL_ALREADY_REGISTERED` — including the first registration in a
freshly created, provably empty schema.

```
CREATE_1                  ok
ROWS_IN_SCHEMA            0        <- the row we just created is not here
CREATE_2_AFTER_TRUNCATE   NULL(duplicate)
```

**What we assumed** — in order, each one wrong:

1. *Stale data.* Truncated `public.users`. Still failed.
2. *`?schema=` not honoured by the adapter.* Switched to
   `options=-c search_path=...`. Still failed.
3. *`citext` unreachable from a non-public schema.* True, and fixed — but not the cause.
4. *`process.pid` colliding across parallel test files.* Plausible, fixed, still failed.

Four wrong theories before probing what was actually happening.

**Root cause**

**Prisma's generated client bakes the schema name from `schema.prisma` into its SQL and
ignores the connection's `search_path`. Raw queries honour it.**

```
  connection search_path = "test_abc",public

  prisma.user.create()         ->  writes to public     (baked in at generate time)
  $queryRawUnsafe('...users')  ->  reads  test_abc      (honours search_path)
```

Test setup and assertions read one schema; the code under test wrote another. A brand-new
empty schema reporting a duplicate email reads like a logic bug and is a targeting bug.

**Fix**

One shared schema, `fileParallelism: false` in `vitest.config.ts`. Cost is wall-clock
(~300ms → ~7s), not correctness.

Per-schema isolation would need a generated client *per schema* — far more machinery than
one flag.

**Lesson — two, and the second is the bigger one**

*Technical:* this sinks schema-per-test-file isolation on Prisma, and generalises to any
**schema-per-tenant** multi-tenant design. Worth remembering before Module 5's tenancy
work.

*Method:* four theories were tried before running a probe that would distinguish between
them. The probe that finally collapsed the search space was three lines:

```ts
const sp = await prisma.$queryRawUnsafe(`SHOW search_path`)
// -> correctly set. So the POOL was never the problem.
```

That result eliminated everything about connection configuration at once and redirected
attention to the client. **Probe to distinguish hypotheses, not to confirm the current
one.** Each of the four fixes was plausible, each was cheap to try, and trying them in
sequence was still slower than one measurement.

**Cost** — ~40 minutes. The most expensive thing in the sprint.

---

## 5. A stale row masked the real fix

**Symptom**

After correctly diagnosing #4, the suite *still* failed identically. Strong signal that
the diagnosis was wrong.

**What we assumed**

That the fix had not worked.

**Root cause**

The very first broken run — before any isolation existed — wrote a row into
`public.users`. Every later run then hit a genuine duplicate. The fix was correct from the
moment it was applied; the leftover state hid it.

**Fix**

```sql
TRUNCATE public.users CASCADE;
```

**Lesson**

**When a fix does not take, check whether earlier failures left state behind before
concluding the fix is wrong.** Failed runs against a *durable* store are not free — they
mutate the thing you are testing against.

This is specifically a durability hazard. In-memory tests could not do this: the state
died with the process. It is the same class of problem as the reaper (issue #1) —
persistence removes cleanups you were getting by accident.

**Cost** — ~15 minutes, entirely spent doubting a correct fix.

---

## 6. A hand-written hash that happened to work

**Symptom**

None. Tests passed.

**What we assumed**

While writing the timing-attack defence, `DUMMY_HASH` was hand-authored as a literal
Argon2 string rather than generated. Flagged at the time as unverified — `argon2.verify()`
might have thrown on it, and our `catch` would have returned `false` fast, weakening the
very defence it existed for.

**Root cause**

It parsed fine (48.5ms vs 39.9ms for a real verify). But it was frozen at
`m=65536,t=3,p=4` — today's config defaults.

The moment `ARGON2_MEMORY_COST` is tuned — which `config.ts` explicitly instructs you to
do after benchmarking on production hardware — real users verify at the new cost and
missing users at the old one. The timing leak reopens, **and every test still passes.**

**Fix**

Derive it from the instance's own hasher, cached after first use:

```ts
this.dummyHash ??= await this.hasher.hash(randomBytes(32).toString('hex'))
```

Verified at `m=128MiB` — params the constant never knew about:

```
existing user, wrong password   96.4 ms
NO SUCH USER                    99.0 ms     ratio 1.03x
```

**Lesson**

A security control that is correct *today* and silently degrades on a future config change
is worse than one that is visibly wrong, because nothing will ever tell you. The test
asserted "the missing-user path is not a trivially fast early return" — which the frozen
constant would have kept satisfying while the real gap widened to 2.6×.

**Ask of any security control: what routine change makes this stop working, and would
anything notice?**

Caching matters too. Generating per call would cost `hash()` + `verify()` ≈ 2× a real
verify, **inverting** the leak so that slow now means "no such user".

**Cost** — 15 minutes, including the benchmark.

---

## Patterns across the sprint

**Verify the tool before building on it.** #1 and #2 were both caught by reading what an
install actually produced rather than assuming success.

**Probe to discriminate, not to confirm.** #4 cost 40 minutes because four plausible fixes
were tried before one measurement that could rule things out.

**Durability removes accidental cleanup.** #5 and issue #1 are the same shape: in-memory
state died with the process, and Postgres does not. Every implicit cleanup that restarts
were providing now needs to be explicit.

**Green tests are not proof of a security property.** #6 passed throughout. Timing,
entropy and leakage need direct measurement — which is what `pnpm bench:hash` and the
curl timing runs are for.
