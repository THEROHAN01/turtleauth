# Conventions

How work is named, versioned, and shipped in TurtleAuth. Set once so every sprint after
this one is mechanical.

---

## Sprint model

**One sprint = one module.** Six modules, six sprints. A sprint ships a complete
capability, and the roadmap's module boundaries already mark where one capability ends
and the next begins.

```
Sprint 1  ──  Module 1   Authentication Foundations
              password auth, sessions, cookies, HTTP layer, Postgres

Sprint 2  ──  Module 2   JWT + Token Architecture
Sprint 3  ──  Module 3   Web Security + Auth Attacks
Sprint 4  ──  Module 4   OAuth 2.0 + OIDC + Social Login
Sprint 5  ──  Module 5   MFA + Passkeys + Authorization
Sprint 6  ──  Module 6   Production Auth Service + System Design
```

Work within a sprint ships incrementally — `v0.1.0` was password auth on in-memory
storage, `v0.1.1` adds Postgres — but the sprint is not complete until the whole module's
practical is done.

A sprint is done when: tests pass, typecheck is clean, notes are written, `challenges/`
records what went wrong, and the capability works end-to-end against a running server —
not just in unit tests.

---

## Version numbers

`0.MINOR.PATCH` while pre-1.0. **Minor = sprint number = module number.**

```
0.1.0   Sprint 1   password auth + in-memory sessions
0.1.1   Sprint 1   + Postgres persistence          <- same sprint, incremental
0.2.0   Sprint 2   JWT access + refresh tokens
0.3.0   Sprint 3   attack lab + rate limiting
0.4.0   Sprint 4   OAuth 2.0 + OIDC
0.5.0   Sprint 5   MFA + passkeys + RBAC
0.6.0   Sprint 6   production hardening + docs
1.0.0              the service is usable by another application
```

Patch bumps carry incremental work inside an in-progress sprint, as well as fixes to a
shipped one. `package.json` always reflects what is on `main`.

---

## Commit messages

```
<type>(<scope>): <summary>

<body: what changed and WHY — the reasoning, not a file list>

Sprint: <n> — <sprint name>
Module: <n> — <module name>
```

### Types

| Type | Use for |
|---|---|
| `feat` | New capability |
| `fix` | Bug fix |
| `security` | Fixes or hardens a security property — **called out separately on purpose** |
| `refactor` | Restructure, no behaviour change |
| `test` | Tests only |
| `docs` | Notes, discussions, README |
| `chore` | Tooling, deps, config |

`security` is its own type rather than a `fix` because in an auth service you want to be
able to run `git log --grep="^security"` and see every hardening decision in one list.

### Scopes

`hashing` · `session` · `http` · `store` · `config` · `notes` · `discussions` · `build`

### Why trailers instead of a `[S1]` prefix

Trailers are greppable without polluting the subject line:

```bash
git log --grep="Sprint: 1"          # everything in a sprint
git log --grep="^security"          # every hardening decision
git log --oneline                   # still readable
```

---

## Branches

`main` is the trunk. Feature work uses:

```
sprint-<n>/<short-slug>      sprint-1/postgres-store
fix/<short-slug>             fix/cookie-clear-path
```

Sprint 1's first increment was built directly on `main` — acceptable while solo and
pre-1.0. Later increments branch, so `main` always holds a working service.

---

## Tags

Tag `main` at each shippable increment, and at the end of each sprint:

```bash
git tag -a v0.1.1 -m "Sprint 1: Postgres persistence"
```

Tags are what make "show me the service as it was before JWTs existed" a one-command
operation — which matters here, because Module 2 deliberately *replaces* Module 1's
session auth. Without a tag, the stateful implementation is only recoverable by digging
through history.

---

## Notes and discussions

```
discussions/<nn>-<topic>.md      design BEFORE code — questions answered first
notes/module-<n>-.../notes.md    learning concepts, written or revised AFTER code
challenges/sprint-<n>.md         what went wrong DURING the sprint
```

Notes written before implementation get a **"What implementation added"** section
appended once the code exists, rather than being rewritten. The original theory and what
building it actually taught are both worth keeping, and the gap between them is often the
most useful part.

`challenges/` is the third leg: what the plan did not survive contact with. Errors, dead
ends, tools behaving differently than documented, and bugs whose symptom pointed away
from the cause — each with the transferable lesson and roughly what it cost.

Written **during or immediately after** the sprint. Written later, the confusion is
already forgotten and only the tidy version survives, which is the part worth the least.
A sprint is not done until its challenges file exists.
