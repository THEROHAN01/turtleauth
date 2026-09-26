import { Prisma, type PrismaClient } from '@prisma/client'
import type { User, Credential, UserId } from '../core/types.js'
import { asUserId, asCredentialId } from '../core/types.js'

/**
 * User and credential storage, backed by Postgres.
 *
 * Replaces the in-memory Map implementation from v0.1.0. That version is gone rather
 * than kept alongside this one: two implementations drift, and a suite that passes
 * against a Map never proved the SQL path worked.
 *
 * Cost of that choice: tests now need a running database and are slower. Accepted so
 * that what is tested is what ships.
 */

/** Postgres unique-constraint violation. */
const UNIQUE_VIOLATION = 'P2002'

/** Prisma row -> domain object. Keeps Prisma's generated types out of the service layer. */
function toUser(row: {
  id: string
  email: string
  emailVerifiedAt: Date | null
  createdAt: Date
  updatedAt: Date
}): User {
  return {
    id: asUserId(row.id),
    email: row.email,
    emailVerifiedAt: row.emailVerifiedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function toCredential(row: {
  id: string
  userId: string
  type: string
  secret: string
  createdAt: Date
  updatedAt: Date
}): Credential {
  return {
    id: asCredentialId(row.id),
    userId: asUserId(row.userId),
    type: 'password',
    secret: row.secret,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export class PostgresUserStore {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Insert a user and their password credential together.
   *
   * Returns null when the email is taken — detected by CATCHING the unique-constraint
   * violation rather than by checking first.
   *
   * Why: a check-then-insert has a race the Map version did not. Two concurrent
   * registrations both SELECT "not found", then both INSERT:
   *
   *     t0  A: SELECT ... WHERE email='x'  -> none
   *     t1  B: SELECT ... WHERE email='x'  -> none
   *     t2  A: INSERT                      -> ok
   *     t3  B: INSERT                      -> ok      two accounts, one email
   *
   * Single-threaded JS made that impossible in memory, by accident. Postgres will
   * happily interleave. The UNIQUE index is the arbiter; catching P2002 is how the
   * application learns the database refused.
   *
   * Both rows are written in ONE transaction: a user without their credential would be
   * an account nobody can ever log into.
   */
  async createUserWithPassword(
    normalisedEmail: string,
    passwordHash: string,
  ): Promise<User | null> {
    try {
      const row = await this.prisma.user.create({
        data: {
          email: normalisedEmail,
          credentials: {
            create: { type: 'password', secret: passwordHash },
          },
        },
      })
      return toUser(row)
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === UNIQUE_VIOLATION
      ) {
        return null
      }
      throw error
    }
  }

  async findUserByEmail(normalisedEmail: string): Promise<User | undefined> {
    // CITEXT means this matches case-insensitively at the database, independently of
    // whether the caller normalised.
    const row = await this.prisma.user.findUnique({ where: { email: normalisedEmail } })
    return row ? toUser(row) : undefined
  }

  async findUserById(id: UserId): Promise<User | undefined> {
    const row = await this.prisma.user.findUnique({ where: { id } })
    return row ? toUser(row) : undefined
  }

  async findCredentialByEmail(normalisedEmail: string): Promise<Credential | undefined> {
    // One query with a join, not two round trips. Every authenticated login pays this.
    const row = await this.prisma.credential.findFirst({
      where: { type: 'password', user: { email: normalisedEmail } },
    })
    return row ? toCredential(row) : undefined
  }

  /** Replace a stored hash — used by transparent rehash-on-login. */
  async updatePasswordHash(userId: UserId, newHash: string): Promise<void> {
    await this.prisma.credential.update({
      where: { userId_type: { userId, type: 'password' } },
      data: { secret: newHash },
    })
  }
}
