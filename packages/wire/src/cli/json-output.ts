import { writeFile } from "node:fs/promises"

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
  path: string,
  summary: { verb: string; rows: number; cursor: number | null },
): Promise<boolean> {
  try {
    const json = JSON.stringify(value, null, 2)
    if (json === undefined) throw new Error("value is not JSON-serializable")
    await writeFile(path, `${json}\n`)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    console.error(`tribe ${summary.verb}: failed to write JSON to ${path}: ${detail}`)
    process.exitCode = 1
    return false
  }
  console.log(jsonToFileSummary(summary.verb, summary.rows, summary.cursor, path))
  return true
}
