# HTTP Authentication

## The problem

HTTP carries no identity between requests. The server has exactly one place to put
"who is this" — the message itself. There is nowhere else: no connection state you can
trust, no memory, no side channel.

So the real question of this submodule is narrow and mechanical:

> **Which part of an HTTP message carries identity, and what does that choice cost?**

Two answers exist, and they are not interchangeable — they fail to different attacks.

## First principles: what an HTTP message actually is

Plain text over TCP. Three parts.

```
POST /auth/login HTTP/1.1              <- start line: method, path, version
Host: auth.turtle.dev                  <- headers: metadata, key: value
Content-Type: application/json
Content-Length: 52
                                       <- blank line separates headers from body
{"email":"rohan@kpoint.com","pw":"hunter2"}    <- body
```

Response, same shape:

```
HTTP/1.1 200 OK
Content-Type: application/json
Set-Cookie: sid=k7Fq...; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800

{"user":{"id":"usr_01H..."}}
```

**Every authentication mechanism in this entire roadmap lives in the headers.** Sessions,
JWTs, OAuth codes, bearer tokens — all of them are header values. That is the whole
surface area, which is why header semantics deserve precision rather than habit.

### Where credentials go, and why

The password sits in the **body of a POST**. Never the URL. This is not fussiness:

```
GET /login?password=hunter2      <- leaks into, minimum:
                                    - your access logs
                                    - every proxy / load balancer log in the path
                                    - browser history
                                    - the Referer header sent to third-party sites
```

Bodies are not logged by default; URLs are logged everywhere by default. This is the most
common route by which plaintext credentials end up sitting in a log aggregator. GET also
has no body semantics and is cacheable — another reason the method matters.

## The solution, option A: the `Authorization` header

HTTP ships a built-in auth framework (RFC 7235). Server challenges, client answers.

```
   Client                                  Server
     │                                       │
     │──── GET /me ─────────────────────────>│
     │                                       │  no credentials
     │<─── 401 Unauthorized ─────────────────│
     │     WWW-Authenticate: Basic realm=...  │  <- the challenge
     │                                       │
     │──── GET /me ─────────────────────────>│
     │     Authorization: Basic cm9oYW46...  │  <- the answer
     │                                       │
     │<─── 200 OK ───────────────────────────│
```

Format is always: `Authorization: <scheme> <credentials>`

### Buzzword decode: the schemes

| Scheme | Credential | Reality |
|---|---|---|
| `Basic` | `base64(user:password)` | **Encoding, not encryption** — trivially reversed |
| `Bearer` | An opaque token | *Whoever bears it, gets in.* No identity proof |
| `Digest` | Challenge-response hash | Avoids sending the password; largely obsolete |
| `DPoP` | Token **bound to a client key** | Modern fix for bearer theft; beyond this roadmap |

**`Basic` fails at scale for two independent reasons**, and both are worth being able to
state:

1. Base64 is *encoding* — `cm9oYW46aHVudGVyMg==` decodes to `rohan:hunter2` with no key.
   Its only protection is the TLS wrapping it.
2. It sends the password on **every request**. That multiplies exposure, and forces the
   server to run its deliberately-expensive password hash (~250ms of Argon2id, see
   [3-password-hashing-algorithms](../3-password-hashing-algorithms/notes.md)) on every
   single call. You cannot run a 250ms KDF per request — that is a self-inflicted DoS.

> **"Bearer" is a precise word, not branding.** A bearer token is a hotel key card, not a
> passport. It proves nothing about *who* presents it; possession alone is sufficient.
> Two consequences follow directly and are the entire basis of Module 2's design: bearer
> tokens must be **short-lived**, and must travel **only over TLS**. Theft = total
> compromise for the token's remaining lifetime. DPoP exists precisely to break that
> equation by binding the token to a key the client holds.

**Use case:** `Authorization: Bearer` is the right choice for APIs, mobile apps, and
service-to-service calls — clients with no cookie jar, and no CSRF exposure. → Module 2.

## The solution, option B: cookies

### The problem the header could not solve

A browser will **not** attach an `Authorization` header on its own. Application JavaScript
must add it to every request. Which means the token must live somewhere JavaScript can
read it — `localStorage`, memory, anywhere — and **anything JavaScript can read, injected
JavaScript can steal**. That is the XSS exposure, structurally.

Cookies solve a different problem: **automatic, scoped, JS-inaccessible state that the
browser attaches to matching requests with zero application code.**

### The mechanism: two headers

```
  Server ──► Client :  Set-Cookie: sid=k7Fq...; HttpOnly; Path=/
                              (browser stores it in the cookie jar)

  Client ──► Server :  Cookie: sid=k7Fq...
                              (browser attaches it automatically, forever after)
```

No JavaScript participates. That absence is exactly what makes `HttpOnly` possible —
you cannot forbid JS access to a value JS had to attach in the first place.

### The cost of "automatic"

The browser decides whether to send a cookie based on the request's **destination**,
not on **who initiated it**. Follow that to its conclusion:

```
  User is logged into auth.turtle.dev  (browser holds a valid session cookie)
                    │
                    ▼
  User visits evil.com, which contains:
      <form action="https://auth.turtle.dev/account/email" method="POST">
        <input name="email" value="attacker@evil.com">
      </form>
      <script>document.forms[0].submit()</script>
                    │
                    ▼
  Browser sends the POST ── and attaches the session cookie, because the
  DESTINATION matches. It does not care that evil.com initiated it.
                    │
                    ▼
  Server sees a perfectly valid authenticated request. Email changed.
```

**That is CSRF, and it exists entirely because cookies are automatic.** It is not a bug in
cookies — it is the direct cost of the property that makes them useful. → Module 3.

## The core trade-off

Neither option is "safer." You are choosing **which attack class you defend
structurally, and which you must defend with explicit controls.**

| | Cookie | `Authorization` header |
|---|---|---|
| Sent automatically | **Yes** → CSRF exposure | No → CSRF-immune by construction |
| Readable by JS | **No** (with `HttpOnly`) → resists XSS theft | **Yes** → XSS can exfiltrate it |
| Works without JS | Yes | No |
| Non-browser clients | No cookie jar — awkward | Natural fit |
| Scoping | Browser-enforced (`Domain`/`Path`) | Application-controlled |

```
            defends XSS theft                 defends CSRF
                    ▲                              ▲
                    │                              │
              [ Cookie ]                  [ Authorization ]
                    │                              │
             exposed to CSRF              exposed to XSS theft
```

You pick one and then close the other gap deliberately. There is no option that closes
both for free — and an engineer who claims otherwise has not thought it through.

**Decision for TurtleAuth:** cookies for Module 1 (browser sessions, `HttpOnly` gives us
XSS-theft resistance for free), then bearer tokens in Module 2 for API clients. The CSRF
gap that cookies open is closed explicitly in Module 3 (`SameSite` + Origin validation +
CSRF tokens). Both mechanisms coexist in the final service because they serve different
client types.

## Limitations

- **The header approach cannot be made XSS-proof in a browser.** Any token JS can attach,
  JS can steal. Mitigations (short lifetime, in-memory-only storage, refresh rotation)
  reduce the window; they do not close it. → Module 2 refresh rotation, Module 3 XSS.
- **The cookie approach cannot be made CSRF-proof by cookies alone.** `SameSite` is
  enforced by the *browser* — a strong defense against a malicious site, but not a
  server-side guarantee, and non-browser clients ignore it entirely. → Module 3.
- **Neither mechanism authenticates anything by itself.** Both just *transport* a
  credential. Whether that credential means anything is decided by what the server does
  with it: a session lookup ([6-session-authentication](../6-session-authentication/notes.md))
  or a signature verification (Module 2).
- **`Basic` is effectively unusable** for a real login system — per-request password
  transmission plus per-request KDF cost. It survives only in internal tooling behind TLS.

## Interview answers

- **Cookie vs localStorage?** Wrong axis — the real comparison is *cookie vs
  `Authorization` header*, because that is what decides automatic transmission.
  `localStorage` is merely where a header-based token would be parked, and it is readable
  by any injected script. A cookie with `HttpOnly` is not readable by JS but is sent
  automatically, so it trades XSS-theft exposure for CSRF exposure. Choose by client type:
  cookies for browsers, bearer headers for APIs and mobile.
- **Why does a JWT in the `Authorization` header change CSRF risk?** Because CSRF depends
  entirely on the browser attaching credentials *automatically*. A header must be set by
  JavaScript, and `evil.com` cannot execute JavaScript in your origin's context to set it
  — so a forged cross-site request simply arrives with no credential. The risk does not
  vanish; it *moves* to XSS, since the token now lives somewhere JS can read.

---

## What implementation added

Built in `src/routes/auth-routes.ts` (Sprint 1). Three things the theory did not surface.

### Validation is the trust boundary, in code

TypeScript types vanish at compile time. `request.body` is genuinely `any` at runtime:

```ts
const credentialsSchema = z.object({
  email:    z.string().trim().min(3).max(320).email(),
  password: z.string().min(8).max(200),
})
```

`max(200)` is the security-relevant bound, not `min(8)`. Argon2 costs ~250ms on a normal
password; hand it a 10 MB string and that becomes an **attacker-controlled amount of CPU
on an unauthenticated endpoint**. The floor is a policy nicety; the ceiling is a DoS guard.

**But Zod runs AFTER the whole body is parsed.** A 50 MB payload is fully buffered before
validation rejects it. Two guards at different layers:

```
Fastify bodyLimit: 64KB   -> stops it at the socket, before parsing
Zod max(200)              -> stops it before the hasher
```

Only having the second is a memory-exhaustion bug that looks validated.

### One failure shape per endpoint

Login returns **401 for malformed input**, not 400:

```ts
const parsed = credentialsSchema.safeParse(request.body)
if (!parsed.success) return reply.code(401).send({ error: 'INVALID_CREDENTIALS', ... })
```

A 400 would be an oracle: *"that email is malformed"* vs *"wrong credentials"* are
different answers, and the difference is free information for probing input handling.

Register is deliberately different — it legitimately must return 409 on duplicate, because
a service that lets anyone register has to say the address is taken. That endpoint leaks
existence by design; the mitigation is rate limiting, not a status code. → Module 3.

### The error handler is where leakage happens

One handler for the whole app, so no route can forget it:

```ts
if (isAuthError(error)) {
  request.log.info({ code, reason: error.message }, 'auth failure')  // real cause -> logs
  reply.code(error.status).send({ message: error.publicMessage })    // vague -> client
}
request.log.error({ err: error }, 'unhandled')                       // everything -> logs
reply.code(500).send({ message: 'Something went wrong.' })           // nothing -> client
```

Verified: `GET /auth/me` with a forged cookie returns `"Not authenticated."` and the body
contains no trace of the internal `"no such session"`. A stack trace or driver message in
a response body is an information-disclosure bug, not a debugging convenience.

### Measured, not assumed

Timing over real HTTP, 8 requests each:

```
existing user, wrong password   38.1 ms
unknown user                    35.7 ms     ratio 1.07x
```

Indistinguishable from jitter. The uniform 401 body plus the dummy-hash verify both
matter — either alone leaves a channel open.
