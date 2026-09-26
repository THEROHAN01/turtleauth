import type { PrismaClient } from '@prisma/client'
import type { Session, SessionId, UserId } from '../core/types.js'
import { asSessionId, asUserId } from '../core/types.js'

/**
 * Session storage, backed by Postgres.
 *
 * What changed from the in-memory version, and why it matters:
 *
 *   - `byUser` is gone. It was a hand-maintained secondary index; Postgres has
 *     @@index([userId]) and keeps it in sync itself. That was the whole point of the
 *     comparison — a database index is this, done for you.
 *   - Sessions survive restarts and are shared across instances, which is the entire
 *     reason for this change.
 *   - Expired rows are NOT cleaned up. `validateSession` rejects and deletes any it
 *     encounters, but rows nobody touches again accumulate forever. No test fails and
 *     no user sees an error. Tracked as issue #1.
 */

function toSession(row: {
  id: string
  userId: string
  expiresAt: Date
  lastSeenAt: Date
  createdAt: Date
  ip: string | null
  userAgent: string | null
}): Session {
  return {
    id: asSessionId(row.id),
    userId: asUserId(row.userId),
    expiresAt: row.expiresAt,
    lastSeenAt: row.lastSeenAt,
    createdAt: row.createdAt,
    ip: row.ip,
    userAgent: row.userAgent,
  }
}

export class PostgresSessionStore {
  constructor(private readonly prisma: PrismaClient) {}

  async create(session: Session): Promise<void> {
    await this.prisma.session.create({
      data: {
        id: session.id,
        userId: session.userId,
        expiresAt: session.expiresAt,
        lastSeenAt: session.lastSeenAt,
        createdAt: session.createdAt,
        ip: session.ip,
        userAgent: session.userAgent,
      },
    })
  }

  /** Point lookup on the primary key — the query every authenticated request runs. */
  async findById(id: SessionId): Promise<Session | undefined> {
    const row = await this.prisma.session.findUnique({ where: { id } })
    return row ? toSession(row) : undefined
  }

  /**
   * Persist a slid `lastSeenAt`.
   *
   * `updateMany` rather than `update` on purpose: `update` THROWS when the row is gone,
   * and a row can legitimately disappear between a validate and its slide — a logout on
   * another tab, or the reaper once it exists. `updateMany` affects zero rows and
   * returns quietly, which matches the in-memory version's "never resurrect" guard.
   */
  async update(session: Session): Promise<void> {
    await this.prisma.session.updateMany({
      where: { id: session.id },
      data: { lastSeenAt: session.lastSeenAt, expiresAt: session.expiresAt },
    })
  }

  /** Idempotent: deleting an absent session is not an error. */
  async delete(id: SessionId): Promise<void> {
    await this.prisma.session.deleteMany({ where: { id } })
  }

  /**
   * "Log out everywhere". One statement, served by @@index([userId]).
   *
   * This is stateful auth's superpower stated in SQL: revocation is a DELETE, effective
   * on the very next request. Module 2 trades it away for statelessness.
   */
  async deleteAllForUser(userId: UserId): Promise<number> {
    const result = await this.prisma.session.deleteMany({ where: { userId } })
    return result.count
  }

  /** Backs a future "your devices" screen. Newest first. */
  async findAllForUser(userId: UserId): Promise<Session[]> {
    const rows = await this.prisma.session.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    })
    return rows.map(toSession)
  }

  async size(): Promise<number> {
    return this.prisma.session.count()
  }
}
