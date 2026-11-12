import { access, stat, writeFile } from "node:fs/promises"
import { constants, realpathSync } from "node:fs"
import { dirname, isAbsolute, resolve } from "node:path"

/** The one supported way back to rows a consuming read already took (30270). */
export const JSON_TO_FILE_RECOVERY = "tribe log --all --json"

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Physical path of a directory, or undefined when it cannot be resolved (gone, unreadable). */
function physical(dir: string): string | undefined {
  try {
    return realpathSync(dir)
  } catch {
    // silent-fallback-allow: a gone or unreadable directory matches no @in pair; the path then resolves against this process's cwd and the summary line names the absolute path it went to
    return undefined
  }
}

/**
 * 33635 — where a `--json-to-file` path points. An absolute path is used as given. A relative one means "beside me", so
 * under `@in` (which changes directory to the tree it selected before running the command) it resolves against the
 * caller's directory: `@in` exports AT_IN_CALLER_CWD (the caller's cwd) and AT_IN_DIR (the directory it changed to).
 * The pair counts only while this process is still in AT_IN_DIR, so a process that started under `@in` and then
 * changed directory resolves against where it is now. With no matching pair, against this process's cwd.
 */
export function resolveJsonToFilePath(
  path: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  cwd: string = process.cwd(),
): string {
  if (isAbsolute(path)) return path
  const caller = env.AT_IN_CALLER_CWD
  const chosen = env.AT_IN_DIR
  if (caller && chosen) {
    const here = physical(cwd)
    if (here !== undefined && here === physical(chosen)) return resolve(caller, path)
  }
  return resolve(cwd, path)
}

/**
 * 30270 — why a `--json-to-file` target cannot be written, or null when it can.
 * A consuming read must ask this BEFORE the daemon takes the mailbox: the old
 * order advanced the cursor first, so a missing parent directory destroyed the
 * rows the file was meant to keep and the retry read an empty inbox.
 */
export async function jsonDestinationProblem(requested: string): Promise<string | null> {
  const path = resolveJsonToFilePath(requested)
  // An EXISTING target is judged on its own permission: a writable file inside a
  // searchable but read-only directory can be overwritten, so gating it on the
  // parent's W_OK would refuse a destination the write accepts. Only a NEW
  // target needs its parent to admit the entry.
  try {
    const target = await stat(path)
    if (!target.isFile()) return `${path} exists and is not a regular file`
    try {
      await access(path, constants.W_OK)
    } catch {
      return `${path} is not writable`
    }
    return null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return `${path} cannot be inspected: ${errorDetail(error)}`
    }
  }
  const dir = dirname(path)
  let directory
  try {
    directory = await stat(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return `the directory ${dir} does not exist (create it first: mkdir -p "${dir}")`
    }
    return `the directory ${dir} cannot be inspected: ${errorDetail(error)}`
  }
  if (!directory.isDirectory()) return `${dir} is not a directory`
  try {
    await access(dir, constants.W_OK)
  } catch {
    return `the directory ${dir} is not writable`
  }
  return null
}

/** Write one complete machine-readable JSON document or fail the CLI loudly. */
export async function writeJsonStdout(value: unknown, space?: number): Promise<void> {
  try {
    const json = JSON.stringify(value, null, space)
    if (json === undefined) throw new Error("value is not JSON-serializable")
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        // Bun can report the same failed write first through end's callback and
        // then through the stream's error event. Keep the listener armed after
        // a failure so the second report cannot become an uncaught exception.
        if (!error) process.stdout.off("error", onError)
        if (error) reject(error)
        else resolve()
      }
      const onError = (error: Error): void => finish(error)
      process.stdout.on("error", onError)
      try {
        process.stdout.end(`${json}\n`, (error?: Error | null) => finish(error ?? undefined))
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    console.error(`tribe-wire: failed to write complete JSON payload to stdout: ${detail}`)
    process.exitCode = 1
  }
}

/**
 * 28909 — the one-line summary a `--json-to-file` read prints in place of the
 * payload: the row count, the cursor, and where the full JSON went.
 */
export function jsonToFileSummary(verb: string, rows: number, cursor: number | null, path: string): string {
  return `tribe ${verb}: ${rows} row(s), cursor ${cursor === null ? "n/a" : cursor}, written to ${path}`
}

/**
 * 28909 — write one complete JSON document to a FILE and report it in a single
 * line. The harness truncates a stdout pipe at 69,632 bytes (measured: `tribe
 * pending --all --json` is 164 KB), which silently loses rows; a file write is
 * not a pipe, so the full document survives. Success prints ONLY the summary
 * line on stdout — the payload lives in the file. A failed write is loud: the
 * cause is on stderr, the exit code is 1, and the call returns false, never a
 * silently truncated file.
 */
export async function writeJsonToFile(
  value: unknown,
  requested: string,
  summary: { verb: string; rows: number; cursor: number | null; recovery?: string },
): Promise<boolean> {
  // The summary and any failure name the resolved absolute path: the breadcrumb to where the file went (33635).
  const path = resolveJsonToFilePath(requested)
  try {
    const json = JSON.stringify(value, null, 2)
    if (json === undefined) throw new Error("value is not JSON-serializable")
    await writeFile(path, `${json}\n`)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    console.error(`tribe ${summary.verb}: failed to write JSON to ${path}: ${detail}`)
    if (summary.recovery !== undefined) console.error(`  ${summary.recovery}`)
    process.exitCode = 1
    return false
  }
  console.log(jsonToFileSummary(summary.verb, summary.rows, summary.cursor, path))
  return true
}
