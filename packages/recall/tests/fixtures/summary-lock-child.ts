/**
 * Child-process fixture for the two-real-process summary-lock proof (@ag/tribe/27702, AC2).
 *
 * argv: <db-path> <day>
 *   Pre-imports the real engine, prints "ready", waits for one stdin line, then runs the
 *   unmodified `summarizeDay` for <day> with RECALL_DB_PATH=<db-path>, printing its JSON result
 *   on stdout. Pre-booting lets the parent fire the two contenders within milliseconds of each
 *   other, so contention is deterministic without a timing race.
 *   SCOPE (measured, @dev/review2 1180059): the engine's expensive work runs in a SYNCHRONOUS
 *   prefix, so this child's lock is observed by a peer even when released at the return statement.
 *   This fixture proves adoption and crash-release, NOT the early-return ordering — that is the
 *   in-process settlement row in locking-summary-busy.test.ts.
 *
 * <db-path> is the symlink alias: the engine must canonicalise it to the real DB so both
 * processes name one lock.
 */
import { createInterface } from "node:readline"

const [dbPath, day] = process.argv.slice(2)
if (!dbPath || !day) {
  process.stderr.write(`summary-lock-child: expected <db-path> <day>, got ${JSON.stringify(process.argv.slice(2))}\n`)
  process.exit(2)
}
process.env.RECALL_DB_PATH = dbPath

const { summarizeDay } = await import("../../src/lib/summarize-daily.ts")

process.stdout.write("ready\n")

// One line of input is the parent's "go": the operation must not start before it, so both
// contenders are parked at the same line until the parent sequences them.
const lines = createInterface({ input: process.stdin })
await new Promise<void>((resolve) => {
  lines.once("line", () => resolve())
})

try {
  const result = await summarizeDay(day)
  process.stdout.write(`${JSON.stringify(result)}\n`)
} catch (error) {
  process.stderr.write(
    `summary-lock-child: summarizeDay threw: ${error instanceof Error ? error.message : String(error)}\n`,
  )
  process.exit(1)
}
process.exit(0)
