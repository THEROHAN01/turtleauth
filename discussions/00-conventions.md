# Conventions

How work is named, versioned, and shipped in TurtleAuth. Set once so every sprint after
this one is mechanical.

---

## Sprint model

One sprint = one shippable capability. Sprints map to the roadmap's modules, but a module
with a large practical (Module 1, Module 6) splits into several.

```
Module 1 ─┬─ Sprint 1   password auth + in-memory sessions + HTTP layer
          └─ Sprint 2   Postgres persistence
Module 2 ─── Sprint 3   JWT access + refresh tokens
Module 3 ─┬─ Sprint 4   attack lab (break it)
          └─ Sprint 5   rate limiting + hardening (fix it)
Module 4 ─── Sprint 6   OAuth 2.0 + OIDC + Google login
Module 5 ─┬─ Sprint 7   MFA / TOTP
          └─ Sprint 8   passkeys + RBAC
Module 6 ─┬─ Sprint 9   production hardening + Docker
          └─ Sprint 10  docs + OpenAPI + example clients
```

A sprint is done when: tests pass, typecheck is clean, notes are written, and the
capability works end-to-end against a running server — not just in unit tests.

---

## Version numbers

`0.MINOR.PATCH` while pre-1.0. **Minor = sprint number.**

```
0.1.0   Sprint 1    password auth + sessions
0.2.0   Sprint 2    Postgres
0.3.0   Sprint 3    JWT
...
1.0.0   after Sprint 10 — the service is usable by another application
```

Patch bumps are fixes within a shipped sprint (`0.1.1`). The version in `package.json`
always reflects the last *completed* sprint.

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
sprint-<n>/<short-slug>      sprint-2/postgres-store
fix/<short-slug>             fix/cookie-clear-path
```

Sprint 1 was built directly on `main` — acceptable while solo and pre-1.0, but sprints
from 2 onward branch, so `main` always holds a working service.

---

## Tags

Tag `main` at the end of each sprint:

```bash
git tag -a v0.1.0 -m "Sprint 1: password auth + in-memory sessions"
```

Tags are what make "show me the service as it was before JWTs existed" a one-command
operation — which matters here, because Module 2 deliberately *replaces* Module 1's
session auth. Without a tag, the stateful implementation is only recoverable by digging
through history.

---

## Notes and discussions

```
discussions/<nn>-<topic>.md      design BEFORE code — questions answered first
notes/module-<n>-.../notes.md    learning notes, written or revised AFTER code
```

Notes written before implementation get an **"What implementation added"** section
appended once the code exists, rather than being rewritten. The original theory and what
building it actually taught are both worth keeping, and the gap between them is often the
most useful part.
