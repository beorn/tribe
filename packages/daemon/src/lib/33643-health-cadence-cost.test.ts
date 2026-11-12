/**
 * @failure One `tribe.health` call reads row CONTENT and whole history again: measured live
 *          2026-11-11 (33643) at 170-205 MB of reads per cli_health call, 113 MB of it inside
 *          projectHealthCadence (response journal 73 MB, whole-table COUNT(*) 32 MB), so the
 *          once-a-minute coordination-watch cycle makes the single-threaded daemon read
 *          1.1-1.4 GB a minute on its main thread.
 * @level l2
 * @consumer tribe.health / cli_health, via projectHealthCadence() (response_latency and database).
 * @testonly none
 *
 * Two probes in the read-syscall style of health-cadence-response-latency.test.ts (24284), with
 * `PRAGMA cache_size` pinned small so the counter reflects pages visited:
 *
 *   Probe C holds the in-window request/response pairs fixed and grows only the size of their
 *   message CONTENT. The latency projection reports sender, type and timestamps, never content,
 *   so its cost must not track content size. A plan that seeks `ts` and then reads the whole
 *   table row walks each row's overflow chain to reach `reply`, which sits after `content`.
 *
 *   Probe D holds the in-window set fixed and grows only OUT-OF-WINDOW history (live and
 *   archive). Every section of projectHealthCadence reports a window, so its cost must stay
 *   flat; an unbounded `COUNT(*)` over each table tracks the growth.
 */

import { assertSingleStatement } from "@bearly/sqlite"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Database } from "bun:sqlite"

import { openDatabase } from "./database.ts"
import { projectHealthCadence, responseLatencyProjection } from "./health-cadence.ts"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const NOW = 1_800_000_000_000

function readSyscalls(): number {
  const io = readFileSync("/proc/self/io", "utf8")
  const match = io.match(/syscr:\s*(\d+)/)
  if (!match) {
    throw new Error(`/proc/self/io exposes no syscr field — cannot bound page reads. Read: ${io.slice(0, 200)}`)
  }
  return Number(match[1])
}

type Fixture = { db: Database; dir: string }
const open: Fixture[] = []

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "tribe-33643-health-cost-"))
  const entry = { db: openDatabase(join(dir, "tribe.db")), dir }
  open.push(entry)
  return entry
}

afterEach(() => {
  for (const entry of open.splice(0)) {
    entry.db.close()
    rmSync(entry.dir, { recursive: true, force: true })
  }
})

type Row = {
  id: string
  type: string
  ts: number
  content: string
  request?: string
  reply?: string
  archive?: boolean
}

function insert(db: Database, rows: readonly Row[]): void {
  const live = db.prepare(
    `INSERT INTO messages (id, type, sender, recipient, kind, content, ts, delivery, request, reply)
     VALUES ($id, $type, '@dev/1', '@chief', 'direct', $content, $ts, 'push', $request, $reply)`,
  )
  const archived = db.prepare(
    `INSERT INTO messages_archive (seq, id, type, sender, recipient, kind, content, ts, delivery, request, reply, archived_at)
     VALUES ($seq, $id, $type, '@dev/1', '@chief', 'direct', $content, $ts, 'push', $request, $reply, $ts)`,
  )
  db.run("BEGIN")
  let seq = 1
  for (const row of rows) {
    const params = {
      $id: row.id,
      $type: row.type,
      $content: row.content,
      $ts: row.ts,
      $request: row.request ?? null,
      $reply: row.reply ?? null,
      $seq: seq++,
    }
    if (row.archive) archived.run(params as never)
    else live.run(params as never)
  }
  db.run("COMMIT")
}

/** `pairs` in-window request/response pairs whose content is `contentBytes` long. */
function inWindowPairs(pairs: number, contentBytes: number): Row[] {
  const content = "x".repeat(contentBytes)
  return Array.from({ length: pairs }, (_, i) => {
    const ts = NOW - 2 * HOUR - i * MINUTE
    return [
      { id: `req-${i}`, type: "request", ts, content, request: `k-${i}` },
      { id: `res-${i}`, type: "response", ts: ts + MINUTE, content, reply: `k-${i}` },
    ]
  }).flat()
}

/** `count` rows strictly outside every window the projection reports, split live/archive. */
function outOfWindowHistory(count: number): Row[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `old-${i}`,
    type: "notify",
    ts: NOW - 60 * DAY - i * MINUTE,
    content: "old",
    archive: i % 2 === 0,
  }))
}

function costPerCall(db: Database, call: () => unknown): number {
  db.run("PRAGMA cache_size = 32")
  call() // settle statement and schema pages first
  const before = readSyscalls()
  const iterations = 5
  for (let i = 0; i < iterations; i++) call()
  return (readSyscalls() - before) / iterations
}

function build(rows: readonly Row[]): Database {
  const { db } = fixture()
  insert(db, rows)
  return db
}

describe("33643 a health call reads neither message content nor whole history", () => {
  it("probe C: the response-latency projection does not track the size of in-window content", () => {
    const small = build(inWindowPairs(40, 64))
    const large = build(inWindowPairs(40, 64 * 1024))

    const lean = costPerCall(small, () => responseLatencyProjection(small, NOW))
    const fat = costPerCall(large, () => responseLatencyProjection(large, NOW))

    expect(fat, `read syscalls per call: 64 B content ${lean}, 64 KiB content ${fat}`).toBeLessThan(
      Math.max(lean, 1) * 1.5,
    )
  })

  it("reads every response-latency column from a covering index, and a dropped index fails loudly", () => {
    const db = build(inWindowPairs(2, 64))
    const sql: string[] = []
    const statements: Array<{ finalize(): void }> = []
    const prepare = db.prepare.bind(db)
    const spy = vi.spyOn(db, "prepare").mockImplementation(((text: string) => {
      sql.push(text)
      const statement = prepare(text)
      statements.push(statement)
      return statement
    }) as typeof db.prepare)
    try {
      responseLatencyProjection(db, NOW)
    } finally {
      spy.mockRestore()
    }
    const [projection] = sql.filter((text) => text.includes("response_journal"))
    if (projection === undefined) throw new Error("responseLatencyProjection prepared no response_journal statement")
    const explain = db.prepare(assertSingleStatement(`EXPLAIN QUERY PLAN ${projection}`))
    const plan = (explain.all({ $cutoff: NOW - DAY, $now: NOW }) as Array<{ detail: string }>).map((row) => row.detail)
    // An open statement holds the schema; DROP INDEX below needs every one finalized.
    for (const statement of [...statements, explain]) statement.finalize()
    for (const index of [
      "idx_messages_reply_cover",
      "idx_messages_archive_reply_cover",
      "idx_messages_request_cover",
      "idx_messages_archive_request_cover",
    ]) {
      expect(
        plan.some((detail) => detail.includes(`USING COVERING INDEX ${index}`)),
        plan.join(" | "),
      ).toBe(true)
    }
    db.run("DROP INDEX idx_messages_reply_cover")
    expect(() => responseLatencyProjection(db, NOW)).toThrow(/no such index: idx_messages_reply_cover/)
  })

  it("probe D: the whole cadence projection does not track out-of-window history", () => {
    const lean = build([...inWindowPairs(20, 64), ...outOfWindowHistory(200)])
    const huge = build([...inWindowPairs(20, 64), ...outOfWindowHistory(60_000)])
    const cadence = (db: Database) => () =>
      projectHealthCadence(db, { now: NOW, connectedSessionNames: [], dbGrowthWarning: { kind: "unset" } })

    const leanCost = costPerCall(lean, cadence(lean))
    const hugeCost = costPerCall(huge, cadence(huge))

    expect(hugeCost, `read syscalls per call: 200 old rows ${leanCost}, 60,000 old rows ${hugeCost}`).toBeLessThan(
      Math.max(leanCost, 1) * 1.5,
    )
  })
})
