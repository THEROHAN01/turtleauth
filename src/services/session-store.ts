import type { Session, SessionId, UserId } from '../core/types.js'

/**
 * In-memory session storage.
 *
 * Same deliberate choice as InMemoryUserStore: no interface yet. When Postgres arrives
 * we extract the interface from two real implementations rather than guessing at one.
 *
 * Production limitation, stated plainly: this lives in ONE process's memory. Restart the
 * server and everyone is logged out; run two servers and each has a different view of
 * who is logged in. That is exactly why Module 1 ends with Postgres.
 * → notes/module-1-authentication-foundations/7-session-storage
 */
export class InMemorySessionStore {
  private readonly sessions = new Map<SessionId, Session>()

  /**
   * Secondary index: userId -> set of that user's session ids.
   *
   * Without this, "log out all devices" means scanning every session in the map — O(n)
   * in total sessions. Postgres will do this with an index on `user_id`; a Map needs it
   * maintained by hand, which is the cost of keeping both structures in sync below.
   */
  private readonly byUser = new Map<UserId, Set<SessionId>>()

  create(session: Session): void {
    this.sessions.set(session.id, session)

    let userSessions = this.byUser.get(session.userId)
    if (!userSessions) {
      userSessions = new Set()
      this.byUser.set(session.userId, userSessions)
    }
    userSessions.add(session.id)
  }

  findById(id: SessionId): Session | undefined {
    return this.sessions.get(id)
  }

  /** Used by the sliding idle-timeout. Replaces the stored record wholesale. */
  update(session: Session): void {
    // Only update a session we already hold — never resurrect a deleted one, or a
    // logged-out session could be revived by an in-flight concurrent request.
    if (!this.sessions.has(session.id)) return
    this.sessions.set(session.id, session)
  }

  delete(id: SessionId): void {
    const session = this.sessions.get(id)
    if (!session) return

    this.sessions.delete(id)

    const userSessions = this.byUser.get(session.userId)
    if (userSessions) {
      userSessions.delete(id)
      // Drop the empty Set so byUser does not grow forever with empty entries.
      if (userSessions.size === 0) this.byUser.delete(session.userId)
    }
  }

  /** "Log out everywhere" — the operation stateful sessions make trivial. */
  deleteAllForUser(userId: UserId): number {
    const userSessions = this.byUser.get(userId)
    if (!userSessions) return 0

    const count = userSessions.size
    // Copy before iterating: delete() mutates the same Set we are walking.
    for (const id of [...userSessions]) this.delete(id)
    return count
  }

  /** All live sessions for a user — backs a "your devices" screen later. */
  findAllForUser(userId: UserId): Session[] {
    const ids = this.byUser.get(userId)
    if (!ids) return []
    return [...ids]
      .map((id) => this.sessions.get(id))
      .filter((s): s is Session => s !== undefined)
  }

  /** Test/diagnostic helper. Postgres would answer this with COUNT(*). */
  size(): number {
    return this.sessions.size
  }
}
