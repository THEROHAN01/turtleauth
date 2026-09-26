/**
 * Static OpenAPI document for Swagger UI.
 *
 * Deliberately hand-written rather than generated from the Zod schemas already used in
 * `auth-routes.ts`. Those schemas drive runtime *validation*; wiring Fastify's schema
 * system to them as well (via a type provider) would make Fastify validate the body a
 * second time, ahead of the handler, and return Fastify's own error shape instead of
 * ours — which would break the login endpoint's deliberate "always 401, never 400" rule
 * (see `authErrorHandler` / `credentialsSchema` comments). A static document describes
 * behaviour without being wired into it, so it can carry HTTP-status nuances like that
 * one that a schema alone can't express, and it can never accidentally change what the
 * API does.
 *
 * Keep this in sync by hand when a route's request/response shape changes.
 */

import type { OpenAPIV3 } from 'openapi-types'

const publicUserSchema: OpenAPIV3.SchemaObject = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    email: { type: 'string', format: 'email' },
    emailVerified: { type: 'boolean' },
    createdAt: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'email', 'emailVerified', 'createdAt'],
}

const errorSchema: OpenAPIV3.SchemaObject = {
  type: 'object',
  properties: {
    error: { type: 'string' },
    message: { type: 'string' },
  },
  required: ['error', 'message'],
}

const credentialsBody: OpenAPIV3.SchemaObject = {
  type: 'object',
  properties: {
    email: { type: 'string', format: 'email', minLength: 3, maxLength: 320 },
    password: {
      type: 'string',
      minLength: 8,
      maxLength: 200,
      description: 'Max 200: bounds Argon2 cost before it reaches the hasher, on an unauthenticated endpoint.',
    },
  },
  required: ['email', 'password'],
}

export const openApiDocument: OpenAPIV3.Document = {
  openapi: '3.0.3',
  info: {
    title: 'TurtleAuth',
    version: '0.1.1',
    description:
      'Password authentication with server-side, Postgres-backed sessions. Session state ' +
      'lives in an httpOnly cookie (`sid` locally, `__Host-sid` in production) — "Try it ' +
      'out" below carries it automatically between calls in this browser tab.',
  },
  servers: [{ url: '/', description: 'This server' }],
  tags: [
    { name: 'auth', description: 'Registration, login, session lifecycle' },
    { name: 'health', description: 'Liveness/readiness' },
  ],
  components: {
    securitySchemes: {
      cookieAuth: {
        type: 'apiKey',
        in: 'cookie',
        name: 'sid',
        description:
          'Session cookie set by /auth/register or /auth/login. Named `__Host-sid` ' +
          'instead of `sid` when the server runs with secure cookies (production).',
      },
    },
    schemas: {
      Credentials: credentialsBody,
      PublicUser: publicUserSchema,
      Error: errorSchema,
    },
  },
  paths: {
    '/health': {
      get: {
        tags: ['health'],
        summary: 'Liveness and database connectivity',
        responses: {
          '200': {
            description: 'Process is up and reached Postgres.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { status: { type: 'string' }, database: { type: 'string' } },
                },
                example: { status: 'ok', database: 'ok' },
              },
            },
          },
          '503': {
            description: 'Process is up but cannot reach Postgres.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { status: { type: 'string' }, database: { type: 'string' } },
                },
                example: { status: 'degraded', database: 'unreachable' },
              },
            },
          },
        },
      },
    },
    '/auth/register': {
      post: {
        tags: ['auth'],
        summary: 'Create an account',
        description:
          'Auto-logs-in on success (sets the session cookie) — the caller just proved ' +
          'they chose this password. Does NOT verify the email address is owned by the ' +
          'caller.',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Credentials' } } },
        },
        responses: {
          '201': {
            description: 'Account created and session cookie set.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { user: { $ref: '#/components/schemas/PublicUser' } },
                },
              },
            },
          },
          '400': {
            description: 'VALIDATION_FAILED — malformed email or password.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          },
          '409': {
            description: 'EMAIL_ALREADY_REGISTERED.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          },
        },
      },
    },
    '/auth/login': {
      post: {
        tags: ['auth'],
        summary: 'Authenticate and start a session',
        description:
          'Mints a brand-new session id on every successful login (defeats session ' +
          'fixation). Malformed input, wrong password, and an unknown email all return ' +
          'the SAME 401 INVALID_CREDENTIALS — deliberately, so this endpoint cannot be ' +
          'used to enumerate registered addresses.',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Credentials' } } },
        },
        responses: {
          '200': {
            description: 'Authenticated; a fresh session cookie is set.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { user: { $ref: '#/components/schemas/PublicUser' } },
                },
              },
            },
          },
          '401': {
            description: 'INVALID_CREDENTIALS — covers bad input, wrong password, and unknown email alike.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          },
        },
      },
    },
    '/auth/me': {
      get: {
        tags: ['auth'],
        summary: 'Current session',
        security: [{ cookieAuth: [] }],
        responses: {
          '200': {
            description: 'Session is valid (checked server-side; the cookie itself is untrusted).',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    user: { $ref: '#/components/schemas/PublicUser' },
                    session: {
                      type: 'object',
                      properties: {
                        createdAt: { type: 'string', format: 'date-time' },
                        expiresAt: { type: 'string', format: 'date-time' },
                      },
                    },
                  },
                },
              },
            },
          },
          '401': {
            description: 'NOT_AUTHENTICATED / SESSION_INVALID / SESSION_EXPIRED — no cookie, unknown, or expired session.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          },
        },
      },
    },
    '/auth/logout': {
      post: {
        tags: ['auth'],
        summary: 'End the current session',
        description:
          'Always 204, cookie or not — logout has nothing to reveal about whether a ' +
          'given session id was ever valid.',
        security: [{ cookieAuth: [] }],
        responses: {
          '204': { description: 'Session (if any) deleted server-side; cookie cleared.' },
        },
      },
    },
    '/auth/logout-all': {
      post: {
        tags: ['auth'],
        summary: 'End every session for this user ("log out all devices")',
        security: [{ cookieAuth: [] }],
        responses: {
          '200': {
            description: 'All sessions for the authenticated user were deleted.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { sessionsEnded: { type: 'integer' } },
                },
              },
            },
          },
          '401': {
            description: 'NOT_AUTHENTICATED / SESSION_INVALID / SESSION_EXPIRED.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          },
        },
      },
    },
  },
}
