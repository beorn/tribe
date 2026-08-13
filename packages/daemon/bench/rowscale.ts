/**
 * Does per-request cost track the `sessions` row count?
 *
 * This is the harness behind the daemon-wedge perf numbers. It seeds N session
 * rows plus real attention rows and times the reads that timed out during the
 * incident. What matters is the SHAPE: flat means a row count the daemon
 * survives; linear means every leaked registration is charged to every future
 * request.
 *
 * Two attention topics are measured because they take different paths:
 *   - "chat"   — not a registered trust topic, so the roster is never read.
 *   - "bead:x" — internal tier, so every row is checked against the roster.
 *
 * Not a test: it lives outside `src/` so vitest's include patterns
 * (`packages/daemon/src/**\/*.test.ts`) never collect it.
 *
 *   bun packages/daemon/bench/rowscale.ts
 *
 * IT CHECKS ITS OWN INSTRUMENT FIRST, and that is not decoration. An earlier
 * version of this harness wrapped its seeding in `db.transaction(() => {...})`
 * without calling the returned function, so nothing was ever inserted. It
 * timed empty tables and reported every column flat — on the fixed build AND
 * on the unfixed one, which reads as "there was never a problem". Numbers from
 * a silent-zero instrument are worse than no numbers, so the seed is asserted
 * before anything is timed.
 */
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createTribeContext } from "../src/lib/context.ts"
import { createStatements, openDatabase } from "../src/lib/database.ts"
import { readAttentionProjection } from "../src/lib/handlers.ts"
import { derivedLaunchPrefixUpperBound } from "../src/lib/launch-prefix-range.ts"
import { countDurableSessionRows } from "../src/lib/session.ts"

const ROW_COUNTS = [100, 500, 2_000, 8_000, 20_000]
const REPS = 100
const ATTENTION_ROWS = 50

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

function timeIt(reps: number, fn: () => void): number {
  fn() // warm
  const samples: number[] = []
  for (let i = 0; i < reps; i++) {
    const started = performance.now()
    fn()
    samples.push(performance.now() - started)
  }
  return median(samples)
}

function build(rowCount: number, topic: string) {
  const dir = mkdtempSync(join(tmpdir(), `rowscale-${rowCount}-`))
  const db = openDatabase(join(dir, "tribe.db"))
  const stmts = createStatements(db)

  const insertSession = db.prepare(
    "INSERT INTO sessions (id, name, role, domains, pid, cwd, project_id, started_at, updated_at, launch_id, launch_parent_pid) " +
      "VALUES ($id, $name, 'member', '[]', 1, '/repo', 'p', 0, 0, $launch_id, $ppid)",
  )
  // `db.transaction(fn)` RETURNS a function; it must be invoked. See header.
  db.transaction(() => {
    for (let i = 0; i < rowCount; i++) {
      insertSession.run({
        $id: `s${i}`,
        $name: `anon-${i}`,
        $launch_id: i % 2 === 0 ? `launch-${i}` : null,
        $ppid: i % 2 === 0 ? 1000 + i : null,
      })
    }
  })()

  const insertMessage = db.prepare(
    "INSERT INTO messages (id, type, sender, recipient, kind, content, ts, delivery, topic, attention_required) " +
      "VALUES ($id, 'request', $sender, '@reader', 'direct', 'x', 0, 'pull', $topic, 1)",
  )
  db.transaction(() => {
    for (let i = 0; i < ATTENTION_ROWS; i++) {
      // Senders near the END of the roster: the roster match scans linearly,
      // so this is the honest worst case rather than an early-exit best case.
      insertMessage.run({ $id: `m${i}`, $sender: `anon-${Math.max(0, rowCount - 1 - i)}`, $topic: topic })
    }
  })()

  const ctx = createTribeContext({
    db,
    stmts,
    sessionId: "reader",
    sessionRole: "member",
    initialName: "@reader",
    domains: [],
    claudeSessionId: null,
    claudeSessionName: null,
  })
  return { db, stmts, ctx }
}

console.log("rows | inbox-lookup | attention(chat) | attention(bead:*) | durable-census   (median ms)")
console.log("-----|--------------|-----------------|-------------------|---------------")

for (const rowCount of ROW_COUNTS) {
  const plain = build(rowCount, "chat")
  const trust = build(rowCount, "bead:x")

  // Instrument check BEFORE timing: a projection returning zero rows
  // short-circuits the trust filter, and an unseeded table makes every query
  // trivial — both read as "flat" while proving nothing.
  const plainRows = readAttentionProjection(plain.ctx, "@reader").attentionRows.length
  const trustRows = readAttentionProjection(trust.ctx, "@reader").attentionRows.length
  const sessionsSeen = (plain.db.prepare("SELECT count(*) AS c FROM sessions").get() as { c: number }).c
  if (plainRows !== ATTENTION_ROWS || trustRows !== ATTENTION_ROWS || sessionsSeen !== rowCount) {
    throw new Error(
      `instrument check failed at rowCount=${rowCount}: ` +
        `plainRows=${plainRows} trustRows=${trustRows} sessions=${sessionsSeen} — refusing to publish numbers`,
    )
  }

  const derivedPrefix = "launch-42::"
  const derivedPrefixUpper = derivedLaunchPrefixUpperBound(derivedPrefix)
  const inboxMs = timeIt(REPS, () => {
    plain.stmts.getSessionsByProviderLaunchId.all({
      $launch_id: "launch-42",
      $derived_prefix: derivedPrefix,
      $derived_prefix_upper: derivedPrefixUpper,
    })
  })
  const plainMs = timeIt(REPS, () => readAttentionProjection(plain.ctx, "@reader"))
  const trustMs = timeIt(REPS, () => readAttentionProjection(trust.ctx, "@reader"))
  const censusMs = timeIt(REPS, () => countDurableSessionRows(plain.db))

  console.log(
    `${String(rowCount).padStart(5)}|${inboxMs.toFixed(4).padStart(14)}|${plainMs.toFixed(4).padStart(17)}` +
      `|${trustMs.toFixed(4).padStart(19)}|${censusMs.toFixed(4).padStart(15)}`,
  )
  plain.db.close()
  trust.db.close()
}
