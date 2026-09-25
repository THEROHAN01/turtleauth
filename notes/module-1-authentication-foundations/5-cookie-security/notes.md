# Cookie Security

## The problem

A cookie is a bearer credential the browser hands out **automatically**
(see [4-http-authentication](../4-http-authentication/notes.md)). That creates three
distinct exposures, and each attribute below exists to close exactly one:

| Exposure | The question | Attribute |
|---|---|---|
| Script theft | Can injected JS read it? | `HttpOnly` |
| Network theft | Can a network observer read it? | `Secure` |
| Automatic misuse | Will the browser attach it for *another site*? | `SameSite` |

Plus a fourth, quieter one — **scope**: which hosts and paths receive it at all
(`Domain`, `Path`, and the prefixes that make scope verifiable).

## The structural fact everything else follows from

```
  Server ──►  Set-Cookie: sid=k7Fq...; Domain=turtle.dev; Path=/;
                          Max-Age=604800; HttpOnly; Secure; SameSite=Lax
                          └────┬────┘  └──────────────┬──────────────────┘
                             data          INSTRUCTIONS TO THE BROWSER

  Client ──►  Cookie: sid=k7Fq...
                      └────┬────┘
                      data ONLY — every attribute is gone
```

> **Attributes are never sent back.** The server cannot read a cookie's own flags. It
> cannot verify whether the cookie it just received was stored `Secure`, was `HttpOnly`,
> or which host set it.

This is not a quirk — it is the same "never trust the client" boundary from
[1-authentication-fundamentals](../1-authentication-fundamentals/notes.md), appearing in
cookie form. It is precisely the problem **cookie prefixes** were invented to solve, and
understanding *why* prefixes exist requires understanding this asymmetry first.

## Lifetime: session vs persistent

| | Set by | Stored | Survives browser close |
|---|---|---|---|
| **Session cookie** | no `Expires`/`Max-Age` | memory | No — *in theory* |
| **Persistent cookie** | `Max-Age=N` or `Expires=<date>` | disk | Yes |

Prefer `Max-Age` (relative seconds) over `Expires` (absolute date) — `Expires` depends on
the client clock, and a skewed clock silently changes your security window.

**Misconception worth killing:** session cookies are *not* a reliable security boundary.
"Continue where you left off" session-restore in Chrome and Firefox routinely resurrects
them. Do not design "closes browser ⇒ logged out" around it.

### Deleting a cookie (the logout bug people ship)

`Max-Age=0` deletes. But deletion **matches on `name` + `Domain` + `Path`**. Resend the
wrong scope and the browser creates a *second* cookie instead of removing the first:

```
  set     :  Set-Cookie: sid=abc; Domain=turtle.dev; Path=/
  logout  :  Set-Cookie: sid=;    Path=/; Max-Age=0      <- no Domain!
  result  :  host-only sid="" created; original Domain cookie SURVIVES
             user appears logged out, session still valid on the server
```

### The critical asymmetry

**Cookie expiry is a client-side hint.** The user can edit it; an attacker who stole the
cookie certainly will.

```
  Cookie Max-Age  ──►  UX only: stops sending a cookie you would reject anyway
  Server-side TTL ──►  THE security control
```

Your session must expire **server-side, independently**, or expiry is decorative.
→ [6-session-authentication](../6-session-authentication/notes.md).

## Scope: `Domain` and `Path`

### `Domain` — which hosts receive it

```
  Domain omitted           ->  HOST-ONLY: exactly auth.turtle.dev
                               (tighter, and the correct default)

  Domain=turtle.dev        ->  turtle.dev AND every subdomain:
                               app.turtle.dev, blog.turtle.dev,
                               legacy-wordpress.turtle.dev ...
```

Setting a parent domain is how cross-subdomain SSO works — and how **one compromised
subdomain takes every session**. The blast radius of that marketing WordPress install is
now your auth service.

**Buzzword: cookie tossing.** An attacker controlling `evil.turtle.dev` sets a cookie on
the *parent* domain. The browser dutifully sends it to `app.turtle.dev`. Because
attributes are not transmitted, your server **cannot tell which host set it** — an
attacker-chosen value arrives indistinguishable from your own.

**Buzzword: Public Suffix List (PSL).** A maintained list of "registry" suffixes
(`.com`, `.co.uk`, `.github.io`). Browsers refuse cookies scoped to them — otherwise
anyone could set a cookie for all of `.com`. It is the floor under `Domain`, not a
strategy.

### `Path` — which URL paths receive it

`Path=/api` matches `/api` and `/api/*`.

> **`Path` is NOT a security boundary.** Same-origin JavaScript reads across paths freely.
> Use it to reduce transmission noise; never to isolate.

## `HttpOnly` — the most misunderstood flag

JavaScript cannot read the cookie: absent from `document.cookie`, unreachable via `fetch`.

**Defends:** XSS-driven *exfiltration*. An injected script cannot read the session ID to
ship it to an attacker's server.

**Does NOT defend — and this is the interview trap:**

```
  XSS fires in the user's authenticated page
            │
            ├─► read document.cookie ............ BLOCKED by HttpOnly
            │
            └─► fetch('/account/email', {         NOT BLOCKED
                  method:'POST', credentials:'include',
                  body:'attacker@evil.com' })
                       │
                       ▼
                the browser attaches the cookie AUTOMATICALLY
                       │
                       ▼
                attacker cannot STEAL the session — but USES it
```

`HttpOnly` downgrades XSS from **persistent account takeover** (token exfiltrated, replayed
from anywhere, for as long as it lives) to **session-duration abuse** (actions only from
inside the victim's browser while the session lasts). Real reduction; not a fix.

**The fix for XSS is not letting XSS happen** — output encoding, CSP. → Module 3.

## `Secure` — HTTPS only

Without it, a single plain-HTTP request — a stray `http://` link, an image, an SSL-strip
downgrade — transmits the session ID in cleartext to everyone on the network path.

Always set it. **No dev-time cost:** browsers treat `localhost` as a secure context.

## `SameSite` — the structural CSRF defense

Controls whether the cookie rides along on **cross-site** requests.

| Value | Cross-site behavior | Cost |
|---|---|---|
| `Strict` | Never sent | Following a link from Gmail → your app looks logged out |
| `Lax` | Only on **top-level GET navigations** | Sensible default; modern browser default |
| `None` | Always sent — **requires `Secure`** | You now own CSRF defense entirely |

**Why `Lax` is the right shape:** CSRF attacks that matter are state-changing
(POST/PUT/DELETE) — all blocked. A top-level GET navigation is the user deliberately
clicking through to your site; blocking it breaks the web without adding safety —
***provided your GETs do not change state***. If you have `GET /account/delete`, `Lax`
will not save you, and that endpoint was already wrong. REST method semantics are a
security property here, not style.

**Buzzword: same-site ≠ same-origin.** Two different boundaries; conflating them causes
real bugs.

```
  ORIGIN  = scheme + host + port      https://app.turtle.dev:443
  SITE    = registrable domain        turtle.dev   (eTLD+1, via the PSL)

  app.turtle.dev  vs  api.turtle.dev
      different ORIGIN  (CORS applies)
      same      SITE    (SameSite does NOT block; cookies flow)
```

**Limitation:** `SameSite` is enforced by the **browser**. Strong against a malicious
third-party site; not a server-side guarantee, and non-browser clients ignore it entirely.
Defense in depth = `SameSite` **+** Origin/Referer validation **+** CSRF tokens where
warranted. → Module 3.

## Cookie prefixes — making scope verifiable

Recall the structural problem: the server cannot see a cookie's attributes. Prefixes fix
this by moving the guarantee **into the name**, which *is* transmitted.

| Prefix | Browser refuses to store unless | Buys you |
|---|---|---|
| `__Secure-` | `Secure` is set | Cookie definitely came over HTTPS |
| `__Host-` | `Secure` **+** `Path=/` **+** **no `Domain`** | Definitely host-only — **no subdomain could have set it** |

```
  Cookie: __Host-sid=k7Fq...
          └──┬──┘
    the name arrives at the server, and the browser has already
    ENFORCED host-only + Secure + Path=/ as a condition of storing it
         ──► cookie tossing is structurally impossible
         ──► the one attribute-related thing the server CAN trust
```

**Cost, stated plainly:** `__Host-` forbids `Domain`, so the cookie **cannot be shared
across subdomains**. If you need cross-subdomain SSO, you cannot use it. A real
architectural trade-off, not a free win.

**Decision for TurtleAuth:** default to `__Host-sid`; revisit only if cross-subdomain
sharing becomes a requirement.

## The assembled flow

```
  POST /auth/login              password in body, over TLS
        │
        ▼
  verify hash  (Argon2id ~250ms, constant-time compare)     [submodule 3]
        │
        ▼
  create session server-side    256-bit random ID + SERVER-side expiry  [submodule 6]
        │
        ▼
  Set-Cookie: __Host-sid=...; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800
        │                      └──┬───┘ └──┬─┘ └─────┬──────┘
        │                      no JS   HTTPS    no cross-site POST
        ▼
  browser stores it, and attaches it automatically from now on
        │
        ▼
  Cookie: __Host-sid=...        (attributes stripped — name carries the guarantee)
        │
        ▼
  server looks up session       EXPIRY CHECKED SERVER-SIDE, not from the cookie
        │
        ▼
  authenticated
```

## Limitations

- **No flag defends a stolen cookie.** `HttpOnly`/`Secure`/`SameSite` reduce *acquisition*
  routes; none detect a bearer credential replayed from elsewhere. Detection needs
  server-side session binding, rotation, and audit. → Module 3 session attacks.
- **`SameSite` is browser-enforced**, so it is a mitigation, not a guarantee. → Module 3.
- **`HttpOnly` does not stop XSS**, only theft-by-exfiltration. → Module 3 XSS/CSP.
- **`__Host-` blocks cross-subdomain SSO** — the strongest scoping and the least flexible.
- **All of this is browser-only.** Mobile and service-to-service clients have no cookie
  jar; they need bearer tokens. → Module 2.

## Interview answers

- **Can `HttpOnly` prevent XSS?** No. It prevents the *cookie being read* by injected
  script. The script still executes in the authenticated session and the browser still
  attaches the cookie to requests it makes, so the attacker can act as the user — they
  just cannot export the session for reuse elsewhere. It converts account takeover into
  session-duration abuse.
- **Why is `localStorage` risky?** It is readable by any JavaScript running in the origin,
  so a single XSS exfiltrates the token, which is then replayable from the attacker's own
  machine for the token's full lifetime. A cookie marked `HttpOnly` removes that read path
  entirely — at the cost of automatic transmission, i.e. CSRF exposure.

---

## What implementation added

Built in `src/routes/cookie.ts` (Sprint 1). Flags centralised in one module rather than
spread across handlers — a flag forgotten in one route is a silent vulnerability, and
grepping for `httpOnly` across a codebase is not a security control.

### `__Host-` needs a dev fallback, or login breaks silently

The prefix is enforced by the **browser**: it refuses the cookie unless `Secure` is set,
`Path=/`, and `Domain` is absent. Dev runs plain http, so `Secure` is off, so a
`__Host-` named cookie would be **rejected outright** — and the failure is invisible.
No error, no warning: the browser just does not store it, and login appears to do nothing.

```ts
export function sessionCookieName(secure: boolean): string {
  return secure ? '__Host-sid' : 'sid'
}
```

Observed live: dev returned `set-cookie: sid=...` with no `Secure`. Production
(`NODE_ENV=production`) gets `__Host-sid` with the full set.

**The asymmetry worth remembering:** a missing security flag fails *open* and silently;
a wrongly-applied one fails *closed* and silently. Neither announces itself.

### Clearing must mirror setting, attribute for attribute

```
set:    Set-Cookie: sid=abc; Max-Age=604800; Path=/; HttpOnly; SameSite=Lax
clear:  Set-Cookie: sid=;    Max-Age=0;      Path=/; HttpOnly; SameSite=Lax
```

Mismatch `Path` or `Domain` and the browser creates a **second** cookie instead of
removing the first — the user stays logged in while the UI says they logged out. This is
a frequently-shipped bug, which is why `clearSessionCookieOptions()` exists as a sibling
of the setter rather than as inline options at the logout route.

### Clearing the cookie is not logging out

```ts
if (sessionId) auth.logout(asSessionId(sessionId))          // server forgets it
reply.clearCookie(cookieName, clearSessionCookieOptions())  // browser drops it
```

Only the first line is security. The second is housekeeping: anyone holding a copy of the
value (a proxy log, a shoulder-surfed screenshot, an attacker's clipboard) can replay it
regardless of what the victim's browser does.

Verified by replaying the *same* cookie after logout → 401. That test proves the server
forgot, not merely that the browser was asked to.

### Logout returns 204 unconditionally

Even with no cookie at all. An error would answer *"was that id live?"* — the one question
logout has no reason to answer.

### The `Max-Age` / `expiresAt` split, in code

```
cookie Max-Age = 604800   <- hint. user-editable. stops sending a cookie we'd reject.
session.expiresAt          <- truth. checked in validateSession(), server-side.
```

Test asserts this directly: a 1ms `absoluteLifetimeMs` policy rejects the request while
the cookie's `Max-Age` still says 7 days. The cookie's opinion is irrelevant to the
decision — which is the whole point.
