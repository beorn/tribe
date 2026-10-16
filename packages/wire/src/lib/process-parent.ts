/**
 * The parent of one process: tribe's one reader for it (29567, @cto 6cbf36b7). Linux reads /proc/<pid>/stat; other
 * platforms ask `ps -o ppid= -p <pid>`, bounded at 500 ms. A pid that names no readable process reads as no parent,
 * with the reason it could not be read (@cto cc4f9718), and the caller says what an unknown parent means: the plugin
 * supervisor warns with that reason and fails open, recall stops its walk.
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

/** A process's parent, or why it could not be read: an errno, a ps exit status, a ps timeout, an unparseable line. */
export type ParentPidReading = { readonly ppid: number } | { readonly ppid: null; readonly reason: string }

/**
 * Where the reader looks: the /proc root, and the `ps` it runs where that root has no `self/stat`. The defaults are the
 * system's; the reason table in process-parent.test.ts points them at fixtures, the only way to reach every reason.
 * Not exported (@cto 9eafeeb6 (a)): no caller names it, so the module adds only the optional parameter.
 */
interface ParentPidSources {
  readonly procRoot: string
  readonly ps: string
}

const SYSTEM_SOURCES: ParentPidSources = { procRoot: "/proc", ps: "ps" }

/** The parent of `pid`, or the reason it names no process this reader can read. */
export function readParentPid(pid: number, sources: ParentPidSources = SYSTEM_SOURCES): ParentPidReading {
  const invalid = invalidPid(pid)
  if (invalid !== null) return invalid
  if (!existsSync(`${sources.procRoot}/self/stat`)) return readParentPidFromPs(pid, sources.ps)
  const path = `${sources.procRoot}/${pid}/stat`
  let line: string
  try {
    line = readFileSync(path, "utf8")
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return {
      ppid: null,
      reason: `${path} is unreadable (${code ?? (error instanceof Error ? error.message : String(error))})`,
    }
  }
  const fields = parseProcStatLine(line)
  return fields === null ? { ppid: null, reason: `${path} has no parent field` } : { ppid: fields.ppid }
}

/** `ps -o ppid= -p <pid>`: the reader where there is no /proc. Exported so Linux tests exercise it too. */
export function readParentPidFromPs(pid: number, ps: string = SYSTEM_SOURCES.ps): ParentPidReading {
  const invalid = invalidPid(pid)
  if (invalid !== null) return invalid
  const result = spawnSync(ps, ["-o", "ppid=", "-p", String(pid)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: PS_TIMEOUT_MS,
  })
  if (result.error !== undefined) {
    const code = (result.error as NodeJS.ErrnoException).code
    return {
      ppid: null,
      reason:
        code === "ETIMEDOUT"
          ? `ps timed out after ${PS_TIMEOUT_MS} ms`
          : `ps could not run (${code ?? result.error.message})`,
    }
  }
  if (result.status === null) {
    return {
      ppid: null,
      reason: `ps ended on ${result.signal ?? "no exit status"} inside its ${PS_TIMEOUT_MS} ms bound`,
    }
  }
  if (result.status !== 0) {
    const stderr = result.stderr.trim()
    return { ppid: null, reason: `ps exited ${result.status} for pid ${pid}${stderr ? `: ${stderr}` : ""}` }
  }
  const text = result.stdout.trim()
  return /^\d+$/u.test(text) ? { ppid: Number(text) } : { ppid: null, reason: `ps printed no parent for pid ${pid}` }
}

function invalidPid(pid: number): ParentPidReading | null {
  return Number.isSafeInteger(pid) && pid > 0 ? null : { ppid: null, reason: `${pid} is not a process id` }
}
