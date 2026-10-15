/**
 * The parent of one process: tribe's one reader for it (29567, @cto 6cbf36b7). Linux reads /proc/<pid>/stat; other
 * platforms ask `ps -o ppid= -p <pid>`, bounded at 500 ms. A pid that names no readable process reads as null, and the
 * caller says what an unknown parent means: the plugin supervisor warns and fails open, recall stops its walk.
 *
 * The stat line parser is shared with the daemon's start-time read (readProcessStartTime), because the error-prone
 * part is the same in both: the fields are counted from the LAST ')' of the command name.
 */

import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"

const PS_TIMEOUT_MS = 500

export interface ProcStatFields {
  readonly ppid: number
  /** Field 22: the start time in clock ticks since boot, null when the line ends before it. */
  readonly startTime: string | null
}

/**
 * One /proc/<pid>/stat line. The command name (field 2) is parenthesised and may hold spaces and parentheses, so the
 * fields are counted from its LAST ')'. Null when the line has no such close or no numeric parent.
 */
export function parseProcStatLine(line: string): ProcStatFields | null {
  const close = line.lastIndexOf(")")
  if (close === -1) return null
  const fields = line
    .slice(close + 2)
    .trimEnd()
    .split(" ")
  const ppidText = fields[1] ?? ""
  if (!/^\d+$/u.test(ppidText)) return null
  return { ppid: Number(ppidText), startTime: fields[19] ?? null }
}

/** The parent of `pid`, or null when `pid` names no process this reader can read. */
export function readParentPid(pid: number): number | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  if (!existsSync("/proc/self/stat")) return readParentPidFromPs(pid)
  let line: string
  try {
    line = readFileSync(`/proc/${pid}/stat`, "utf8")
  } catch {
    // silent-fallback-allow: a process that is gone or unreadable has no known parent; the caller names that outcome
    return null
  }
  return parseProcStatLine(line)?.ppid ?? null
}

/** `ps -o ppid= -p <pid>`: the reader where there is no /proc. Exported so Linux tests exercise it too. */
export function readParentPidFromPs(pid: number): number | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  const result = spawnSync("ps", ["-o", "ppid=", "-p", String(pid)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: PS_TIMEOUT_MS,
  })
  const text = result.status === 0 ? result.stdout.trim() : ""
  return /^\d+$/u.test(text) ? Number(text) : null
}
