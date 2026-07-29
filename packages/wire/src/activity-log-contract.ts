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
