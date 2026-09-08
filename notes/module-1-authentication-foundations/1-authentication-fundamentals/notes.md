# Authentication Fundamentals

## The problem

HTTP is stateless. Each request is independent — the protocol gives the server no way to
know request #2 came from whoever sent request #1. TCP connection reuse is transport, not
identity; connections die, get pooled, get load-balanced across machines.

So: **a user authenticates once, but must be recognized on every subsequent request without
re-sending their password.**

Every mechanism in this roadmap is an answer to that single question.

| Mechanism | Answer | Module |
|---|---|---|
| Session cookie | Send an opaque ID; server looks it up | 1 (stateful) |
| JWT | Send a signed claim; server verifies it | 2 (stateless) |
| OAuth / OIDC | A third party vouches for identity | 4 |
| Passkey | Prove key possession per request | 5 |

## The three questions

Conflating these causes a large share of real-world auth bugs.

| | Question | Example |
|---|---|---|
| Identification | Who do you *claim* to be? | "I'm rohan@kpoint.com" |
| Authentication | Can you *prove* it? | "Here's my password" |
| Authorization | What may you *do*? | "Can rohan delete invoice 1234?" |

Identification is an unverified claim — free, anyone can type any email. Authentication is
the proof step that turns the claim into a trusted fact. Authorization runs *after*
authentication and answers a different question entirely.

**The classic failure:** verify the user is logged in, then serve `/invoices/1234` without
checking whether *this* user owns invoice 1234. That is IDOR, still one of the most common
vulnerabilities in shipped software. Fixed by resource-level authorization (Module 5).

**Accounting** (third A in AAA) is the record: who did what, when, from where. Without it a
breach is undetectable and un-investigable. → `audit_logs` (Module 6).

## Identity vs credential

- **Identity** — attributes the system knows about a subject (id, email, roles, verified).
- **Credential** — a thing proving control of that identity (password, TOTP secret, passkey
  private key).

One identity has *many* credentials. Keep them in separate tables (`users`, `credentials`).

**Why:** a `password_hash` column on `users` assumes exactly one credential of one type
forever. Adding passkeys in Module 5, or letting a user hold password + passkey + Google
simultaneously, then means schema surgery on your most-referenced table. Designing for
one-to-many now costs one join and buys the whole roadmap.

## Trust boundaries

A trust boundary is where data crosses from a zone you control into one you don't.

> **Never trust anything that crossed a boundary from the client.**

The client controls its entire request: headers, cookies, body, timing. A cookie reading
`user_id=42` is a *claim*, not a fact — the user can edit it. Hence session IDs must be
unguessable random values looked up server-side, and JWTs must be cryptographically signed.
Both convert an untrusted claim into a verifiable one, by different mechanisms.

**Responsibilities:**

- *Client* — collect credentials, transmit over TLS, store an opaque token, send it back.
  Makes **no** security decisions. Client-side validation is UX only; an attacker uses
  `curl`, not your form.
- *Server* — verify credentials, issue tokens, validate every request, make every
  authorization decision.

"The frontend already checks that" is a statement of vulnerability, not of safety.

## Limitations / open questions

- This module's answer (server-side sessions) is **stateful** — every request costs a
  session lookup, and horizontal scaling needs shared storage. Module 2 trades that for
  stateless JWTs and inherits a different problem: revocation.
- Trust-boundary discipline says validate everything from the client, but validation itself
  costs CPU on unauthenticated endpoints — an attacker-controlled cost. Module 3 (rate
  limiting) has to resolve that tension.

## Interview answers

- **Authentication vs authorization?** Authentication proves who you are; authorization
  decides what you may do. Authentication runs first and once per session; authorization
  runs on every protected resource access.
- **Why is HTTP statelessness the core problem?** Because the protocol carries no identity
  between requests, so the server needs an explicit mechanism to re-recognize a user
  without re-collecting their password.
