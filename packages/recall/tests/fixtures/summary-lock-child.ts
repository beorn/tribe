/**
 * Child-process fixture for the two-real-process summary-lock proof (@ag/tribe/27702, AC2).
 *
 * argv: <role> <db-path> <day>
 *   hold — acquire the exact summary-operation lock the production engine uses (the canonical realpath of
 *          <db-path> plus `.summary.lock`) and hold it until the parent closes this process's stdin. Prints
 *          "held" once acquired, so the parent knows the lock is occupied before it starts the second process.
 *   run  — call the real production `summarizeDay` for <day> with RECALL_DB_PATH naming <db-path>, then print
 *          its JSON result on stdout. This is the unmodified engine the two seats' SessionEnd hooks run.
 *
 * The hold role exists so contention is deterministic: `summarizeDay` holds the lock only across a fast
 * fixture, so a plain two-way race could miss the window. The in-process row already binds production to this
 * same lock path; this row proves that occupancy is felt across real OS processes through the symlink alias.
 */
import { realpathSync } from "node:fs"
import { tryAcquireFlock } from "@bearly/flock"

const [role, dbPath, day] = process.argv.slice(2)
if (!role || !dbPath || !day) {
  process.stderr.write(
    `summary-lock-child: expected <role> <db-path> <day>, got ${JSON.stringify(process.argv.slice(2))}\n`,
  )
  process.exit(2)
}

if (role === "hold") {
  using held = tryAcquireFlock(`${realpathSync(dbPath)}.summary.lock`, {
    body: JSON.stringify({ startedAt: Date.now() }),
  })
  if (held === null) {
    process.stderr.write("summary-lock-child: hold: another owner already holds the summary lock\n")
    process.exit(3)
  }
  process.stdout.write("held\n")
  await new Promise<void>((resolve) => {
    process.stdin.once("end", resolve)
    process.stdin.once("close", resolve)
    process.stdin.resume()
  })
} else if (role === "run") {
  process.env.RECALL_DB_PATH = dbPath
  const { summarizeDay } = await import("../../src/lib/summarize-daily.ts")
  const result = await summarizeDay(day)
  process.stdout.write(`${JSON.stringify(result)}\n`)
} else {
  process.stderr.write(`summary-lock-child: unknown role ${JSON.stringify(role)}\n`)
  process.exit(2)
}
