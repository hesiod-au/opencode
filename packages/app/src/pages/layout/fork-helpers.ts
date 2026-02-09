import { type Session } from "@opencode-ai/sdk/v2/client"

/**
 * Groups root sessions with their task-mode child sessions,
 * returning a flat list with depth indicators for rendering
 * hierarchical session trees in the sidebar.
 *
 * @param rootSessions - Already-sorted root sessions
 * @param allSessions  - Full session list for finding children
 * @param sortFn       - Comparator for ordering child sessions
 */
export function groupSessionsWithChildren(
    rootSessions: Session[],
    allSessions: Session[],
    sortFn: (a: Session, b: Session) => number,
): Array<{ session: Session; depth: number }> {
    const result: Array<{ session: Session; depth: number }> = []
    for (const session of rootSessions) {
        result.push({ session, depth: 0 })
        const children = allSessions
            .filter(
                (s) =>
                    s.parentID === session.id &&
                    !s.time?.archived,
            )
            .toSorted(sortFn)
        for (const child of children) {
            result.push({ session: child, depth: 1 })
        }
    }
    return result
}
