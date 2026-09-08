# TurtleAuth — Learning Notes

First-principles notes written as we work through the Authentication Engineering Roadmap.
Each submodule folder holds a `notes.md` following one shape:

> **What was the problem → what is the solution → what are the limitations.**

Precise over exhaustive. If a note doesn't change how you'd build or debug something,
it doesn't belong.

## Progress

Legend: `[x]` written · `[~]` in progress · `[ ]` not started

### Module 1 — Authentication Foundations
- [x] [1 — Authentication Fundamentals](module-1-authentication-foundations/1-authentication-fundamentals/notes.md)
- [x] [2 — Password Authentication](module-1-authentication-foundations/2-password-authentication/notes.md)
- [x] [3 — Password Hashing Algorithms](module-1-authentication-foundations/3-password-hashing-algorithms/notes.md)
- [ ] 4 — HTTP Authentication
- [ ] 5 — Cookie Security
- [ ] 6 — Session Authentication
- [ ] 7 — Session Storage

### Module 2 — JWT + Token Architecture
- [ ] 1 — JWT Fundamentals
- [ ] 2 — JWT Claims
- [ ] 3 — JWT Cryptography
- [ ] 4 — JWT Validation
- [ ] 5 — Access Tokens
- [ ] 6 — Refresh Tokens
- [ ] 7 — JWT Key Management

### Module 3 — Web Security + Auth Attacks
- [ ] 1 — CSRF
- [ ] 2 — XSS
- [ ] 3 — Session Attacks
- [ ] 4 — JWT Attacks
- [ ] 5 — Credential Attacks
- [ ] 6 — Token Security
- [ ] 7 — Rate Limiting

### Module 4 — OAuth 2.0 + OIDC + Social Login
- [ ] 1 — OAuth 2.0 Fundamentals
- [ ] 2 — OAuth Flows
- [ ] 3 — PKCE
- [ ] 4 — OAuth Security
- [ ] 5 — OIDC
- [ ] 6 — Social Login

### Module 5 — MFA + Passkeys + Authorization
- [ ] 1 — MFA
- [ ] 2 — MFA Security
- [ ] 3 — Passkeys / WebAuthn
- [ ] 4 — Authorization
- [ ] 5 — Account Lifecycle

### Module 6 — Production Auth Service + System Design
- [ ] 1 — Architecture
- [ ] 2 — Database Design
- [ ] 3 — API Design
- [ ] 4 — Production Security
- [ ] 5 — Distributed Authentication
- [ ] 6 — Testing
- [ ] 7 — Deployment
- [ ] 8 — Developer Experience

## Writing notes

Run `/take-notes` after finishing a submodule or module. See
[`.claude/commands/take-notes.md`](../.claude/commands/take-notes.md).
