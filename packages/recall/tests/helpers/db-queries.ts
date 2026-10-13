/**
 * Test-only readers of the recall index.
 *
 * `getSessionStatus` and `getMessageCount` were exported from
 * src/history/db-queries.ts and re-exported by the db.ts barrel, but no
 * production module called them: production reads sessions and messages
 * through src/lib/sessions.ts, src/lib/status.ts and src/history/search.ts.
 * Guard A (E-6, 25637, tools/test-quality.ts --check testonly) flags an export
 * whose only importers are tests, and @chief's E-6 ruling (2026-10-13) sends
 * such a helper to the owner package's test support rather than shipping an
 * unused public surface. They live here, unchanged, for the witness tests that
 * observe the index with them.
 */

import { Database } from "bun:sqlite"

export function getSessionStatus(
  db: Database,
  id: string,
):
  | {
      id: string
      status: string | null
      messageCount: number
      failureReason: string | null
      failureTime: number | null
      shrinkOldCount: number | null
      shrinkNewCount: number | null
    }
  | undefined {
  const row = db
    .prepare(`
    SELECT id, status, message_count as messageCount, failure_reason as failureReason, failure_time as failureTime, shrink_old_count as shrinkOldCount, shrink_new_count as shrinkNewCount
    FROM sessions
    WHERE id = ?
  `)
    .get(id) as {
    id: string
    status: string | null
    messageCount: number | null
    failureReason: string | null
    failureTime: number | null
    shrinkOldCount: number | null
    shrinkNewCount: number | null
  } | null
  return row
    ? {
        id: row.id,
        status: row.status ?? null,
        messageCount: row.messageCount ?? 0,
        failureReason: row.failureReason ?? null,
        failureTime: row.failureTime ?? null,
        shrinkOldCount: row.shrinkOldCount ?? null,
        shrinkNewCount: row.shrinkNewCount ?? null,
      }
    : undefined
}

export function getMessageCount(db: Database, sessionId: string): number {
  const row = db.prepare("SELECT COUNT(*) as count FROM messages WHERE session_id = ?").get(sessionId) as {
    count: number
  }
  return row.count
}
