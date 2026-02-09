import { type Session } from "@opencode-ai/sdk/v2/client"

/**
 * Sort sessions by recency, prioritizing recently-updated
 * sessions before falling back to chronological order.
 */
export function sortSessions(a: Session, b: Session) {
  const now = Date.now()
  const oneMinuteAgo = now - 60 * 1000
  const aUpdated = new Date(a.time.updated ?? a.time.created).getTime()
  const bUpdated = new Date(b.time.updated ?? b.time.created).getTime()
  const aRecent = aUpdated > oneMinuteAgo
  const bRecent = bUpdated > oneMinuteAgo
  if (aRecent && bRecent) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  if (aRecent && !bRecent) return -1
  if (!aRecent && bRecent) return 1
  return bUpdated - aUpdated
}

/**
 * Groups root sessions with their task-mode child sessions,
 * returning a flat list with depth indicators for rendering
 * hierarchical session trees in the sidebar.
 */
export function groupSessionsWithChildren(
  sessions: Session[],
  allSessions: Session[],
  sortFn: (a: Session, b: Session) => number,
): Array<{ session: Session; depth: number }> {
  const result: Array<{ session: Session; depth: number }> = []
  const rootSessions = sessions
    .filter((s) => !s.parentID)
    .toSorted(sortFn)

  for (const session of rootSessions) {
    result.push({ session, depth: 0 })
    const children = allSessions
      .filter((s) => s.parentID === session.id)
      .toSorted(sortFn)
    for (const child of children) {
      result.push({ session: child, depth: 1 })
    }
  }
  return result
}
