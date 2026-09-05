/** Serialized activity-log record shared by the daemon writer and wire reader. */
export type ActivityKind = "dm" | "broadcast" | "event" | "session" | "rename" | "inject" | "gate"
export type ActivitySource = "tribe" | "recall" | "gate"

export interface ActivityEntry {
  ts: number
  source: ActivitySource
  kind: ActivityKind
  session: string
  peer?: string
  type?: string
  preview?: string
  chars?: number
  id?: string
  bead_id?: string | null
  meta?: Record<string, unknown>
}

/** Directory containing the date-stamped activity logs. */
export function activityLogDir(env: NodeJS.ProcessEnv = process.env): string {
  return `${env.HOME ?? ""}/.local/share/tribe`
}

/** Date-stamped filename shared by rotation and follow mode. */
export function activityLogFilename(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `activity-${year}-${month}-${day}.jsonl`
}

const ACTIVITY_LOG_FILENAME_PATTERN = /^activity-\d{4}-\d{2}-\d{2}\.jsonl$/

/**
 * True for exactly the dated filenames activityLogFilename() produces. The
 * one home for this shape — a directory scan that needs to recognize a
 * rotated activity log (pruneOldActivityLogs) matches against this instead
 * of keeping its own copy of the pattern.
 */
export function isActivityLogFilename(name: string): boolean {
  return ACTIVITY_LOG_FILENAME_PATTERN.test(name)
}
