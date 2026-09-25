import type { CookieSerializeOptions } from '@fastify/cookie'

/**
 * Session cookie configuration.
 *
 * Every flag here is a security decision, so they live in one place rather than being
 * scattered across route handlers where one could silently be forgotten.
 * → notes/module-1-authentication-foundations/5-cookie-security
 */

/**
 * The `__Host-` prefix is enforced by the BROWSER, not by us: it refuses the cookie
 * unless Secure is set, Path is exactly "/", and Domain is absent (host-only).
 *
 * Why that matters: the server cannot see a cookie's own attributes — the request only
 * carries `name=value`. So we normally cannot tell whether a cookie was set by us or by
 * a compromised subdomain (cookie tossing). The prefix travels IN THE NAME, which the
 * server does see, making it the one attribute-related guarantee we can actually trust.
 *
 * Cost: `__Host-` forbids Domain, so this cookie can never be shared across subdomains.
 * If cross-subdomain SSO becomes a requirement, this decision has to be revisited —
 * a real architectural trade, not a free win.
 */
export const SESSION_COOKIE_NAME = '__Host-sid'

/**
 * Name used when the prefix cannot apply. Browsers only honour `__Host-` on secure
 * contexts; plain http://localhost IS treated as secure, so this is mainly an escape
 * hatch for proxied dev setups over plain http.
 */
export const SESSION_COOKIE_NAME_INSECURE = 'sid'

export function sessionCookieName(secure: boolean): string {
  return secure ? SESSION_COOKIE_NAME : SESSION_COOKIE_NAME_INSECURE
}

export interface CookieOptions {
  /** false only for local dev over plain http. Never false in production. */
  secure: boolean
  /** Cookie Max-Age in seconds. A HINT to the browser — never the security control. */
  maxAgeSeconds: number
}

/**
 * Options for SETTING the session cookie.
 */
export function sessionCookieOptions(opts: CookieOptions): CookieSerializeOptions {
  return {
    
    httpOnly: true,
    /**
     * Send only over HTTPS. Without it, a single plain-http request — a stray link, an
     * image, a downgrade attack — puts the session id on the wire in cleartext.
     */
    secure: opts.secure,

    /**
     * Lax: sent on top-level GET navigations, withheld on cross-site POST/PUT/DELETE.
     *
     * The reasoning: CSRF attacks that matter are state-changing, and those are
     * blocked. A top-level GET is the user deliberately clicking through to our site.
     *
     * The catch this relies on: our GETs must not change state. A `GET /account/delete`
     * would defeat this entirely — and was already wrong for other reasons.
     *
     * Limitation: enforced by the BROWSER. Non-browser clients do not participate at
     * all, so this is not a substitute for server-side Origin checks. → Module 3.
     */
    sameSite: 'lax',

    /** `__Host-` requires exactly "/". Path is not a security boundary anyway — */
    /** same-origin JS reads across paths freely. */
    path: '/',

    /**
     * Max-Age is a CLIENT-SIDE HINT. The user can edit it, and an attacker holding a
     * stolen cookie certainly will. Real expiry is enforced server-side in
     * AuthService.validateSession. This just stops the browser sending a cookie we
     * would reject anyway.
     */
    maxAge: opts.maxAgeSeconds,
  }
}

/**
 * Options for CLEARING the session cookie at logout.
 *
 * Must match the Domain and Path used when setting it, or the browser creates a SECOND
 * cookie instead of removing the first — a real and frequently-shipped logout bug.
 *
 * Note this only clears the browser's copy. The server-side session must be deleted
 * too: clearing the cookie alone leaves a live session that any copy of the value
 * still opens.
 */
export function clearSessionCookieOptions(secure: boolean): CookieSerializeOptions {
  return {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  }
}
