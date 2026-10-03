/**
 * @failure The health response-latency projection reads the whole live+archive
 *          journal on every call again (measured 166,917 page reads / 684 MB for
 *          ONE call on a copy of the live database), so `tribe.health` blocks the
 *          single-threaded daemon past the wire client's 10 s deadline — or the
 *          bounded rewrite changes which rows and latencies it reports.
 * @level l2
 * @consumer tribe.health / cli_health, via projectHealthCadence().response_latency and the
 *            actionable-response SLA (role_actionable_response) built on its rows.
 * @testonly responseLatencyProjection: exported from module-private so this file can diff its
 *            rows against the frozen pre-fix oracle; the function itself is production code.
 *
 * 24284 defect 1 (@cto ruling 2026-10-03) — the health response-latency
 * projection must cost O(the window it reports), not O(whole journal), and
 * must return exactly the rows the pre-fix two-sided `journal` join returned.
 *
 * Measured on a read-only `.backup` copy of the live 806,952,960-byte DB
 * (messages 266,733 / messages_archive 728,682): ONE `tribe.health` call cost
 * 470,867 page reads (~1.9 GB) with ZERO connected sessions. `projectHealthCadence`
 * materialized `WITH journal AS (SELECT ... FROM messages UNION ALL SELECT ...
 * FROM messages_archive)` — 1M rows — BEFORE applying the 24-hour response
 * cutoff, because the cutoff predicate sat outside the CTE. The synchronous
 * single-threaded daemon then blocked unrelated inbox and members RPCs past the
 * wire client's 10-second deadline, and the ~1.9 GB matched the observed
 * 350-600 MB/s read bursts.
 *
 * Two probes, because a single end-to-end cost assertion cannot say which half
 * regressed:
 *
 *   Probe A grows only the OUT-OF-WINDOW response+request journal. Correct cost
 *   is flat; the whole-journal plan tracks the growth.
 *
 *   Probe B grows only request-bearing rows that no in-window response can
 *   match. Correct cost is flat; a request side without its own index scans the
 *   whole table once per in-window response and tracks the growth.
 *
 * Cost is measured in read syscalls rather than wall time (exact, not load
 * dependent), with `PRAGMA cache_size` pinned small so the counter reflects
 * pages VISITED — with the default cache a fixture this size sits in memory and
 * every plan reports zero reads, an instrument that cannot fail.
 *
 * The equivalence suite keeps the PRE-FIX query as a frozen oracle and compares
 * it row-for-row with the shipped projection, on fixtures that exercise the
 * shapes the ruling named: live/archive split, a duplicate request key present
 * in BOTH tables, an old request with a current response, a missing request, a
 * future response, a response older than its request, and an unknown role.
 */

import { assertSingleStatement } from "@bearly/sqlite"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Database } from "bun:sqlite"

import { CURRENT_SCHEMA_VERSION, openDatabase } from "./database.ts"
import { responseLatencyProjection } from "./health-cadence.ts"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Fixed clock so every expectation below is a literal, not a re-derivation. */
const NOW = 1_800_000_000_000

type LatencyRow = { role: string; sender: string; message_type: string; latency_ms: number }

/**
 * The pre-fix projection, kept verbatim as the equivalence oracle. This is the
 * query that materialized the whole journal; it must keep producing the same
 * rows the bounded rewrite does, or the rewrite changed behaviour, not cost.
 */
const PRE_FIX_ORACLE_SQL = `
  WITH journal AS (
    SELECT id, type, sender, recipient, ts, request, reply FROM messages
    UNION ALL
    SELECT id, type, sender, recipient, ts, request, reply FROM messages_archive
  )
  SELECT
    COALESCE(s.role, 'unknown') AS role,
    response_message.sender AS sender,
    request_message.type AS message_type,
    response_message.ts - request_message.ts AS latency_ms
  FROM journal response_message
  JOIN journal request_message
    ON response_message.reply IS NOT NULL
    AND request_message.request IS NOT NULL
    AND response_message.reply = request_message.request
  LEFT JOIN sessions s ON s.name = response_message.sender
  WHERE response_message.ts >= $cutoff
    AND response_message.ts <= $now
    AND response_message.ts >= request_message.ts
  ORDER BY role, message_type, latency_ms
`

/** Pages this process has read so far. See attention-scan-bounded.test.ts. */
function readSyscalls(): number {
  const io = readFileSync("/proc/self/io", "utf8")
  const match = io.match(/syscr:\s*(\d+)/)
  if (!match) {
    // NO SILENT ERRORS: a missing counter fails the gate rather than quietly
    // turning these into assertions about nothing.
    throw new Error(`/proc/self/io exposes no syscr field — cannot bound page reads. Read: ${io.slice(0, 200)}`)
  }
  return Number(match[1])
}

type Fixture = { db: Database; dir: string }
const open: Fixture[] = []

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "tribe-response-latency-"))
  const db = openDatabase(join(dir, "tribe.db"))
  const entry = { db, dir }
  open.push(entry)
  return entry
}

afterEach(() => {
  for (const entry of open.splice(0)) {
    entry.db.close()
    rmSync(entry.dir, { recursive: true, force: true })
  }
})

function insertSession(db: Database, name: string, role: string): void {
  db.prepare(
    `INSERT INTO sessions (id, name, role, domains, pid, started_at, updated_at, last_inbox_pull_seq)
     VALUES ($id, $name, $role, '[]', 1, $now, $now, 0)`,
  ).run({ $id: `sess-${name}`, $name: name, $role: role, $now: NOW } as never)
}

type MessageRow = {
  id: string
  type: string
  sender: string
  recipient: string
  ts: number
  request?: string | null
  reply?: string | null
  /** Land in messages_archive instead of the live messages table. */
  archive?: boolean
  seq?: number
}

function insertMessages(db: Database, rows: MessageRow[]): void {
  const live = db.prepare(
    `INSERT INTO messages (id, type, sender, recipient, kind, content, ts, delivery, request, reply)
     VALUES ($id, $type, $sender, $recipient, 'direct', $id, $ts, 'push', $request, $reply)`,
  )
  const archived = db.prepare(
    `INSERT INTO messages_archive (seq, id, type, sender, recipient, kind, content, ts, delivery, request, reply, archived_at)
     VALUES ($seq, $id, $type, $sender, $recipient, 'direct', $id, $ts, 'push', $request, $reply, $ts)`,
  )
  let seq = 1
  for (const row of rows) {
    const params = {
      $id: row.id,
      $type: row.type,
      $sender: row.sender,
      $recipient: row.recipient,
      $ts: row.ts,
      $request: row.request ?? null,
      $reply: row.reply ?? null,
      $seq: row.seq ?? seq++,
    }
    if (row.archive) archived.run(params as never)
    else live.run(params as never)
  }
}

/** Cost in read syscalls of ONE `responseLatencyProjection` call. */
function costPerCall(db: Database): number {
  responseLatencyProjection(db, NOW) // settle the statement and schema pages first
  const before = readSyscalls()
  const iterations = 5
  for (let i = 0; i < iterations; i++) responseLatencyProjection(db, NOW)
  return (readSyscalls() - before) / iterations
}

/** A fixed, small in-window set — the part every probe holds constant. */
function insertInWindowSet(db: Database, pairs: number): void {
  const rows: MessageRow[] = []
  for (let i = 0; i < pairs; i++) {
    const requestTs = NOW - 2 * HOUR - i * MINUTE
    rows.push({
      id: `win-req-${i}`,
      type: "request",
      sender: `@dev/${i % 12}`,
      recipient: "@chief",
      ts: requestTs,
      request: `win-${i}`,
    })
    rows.push({
      id: `win-res-${i}`,
      type: "response",
      sender: "@chief",
      recipient: `@dev/${i % 12}`,
      ts: requestTs + MINUTE,
      reply: `win-${i}`,
    })
  }
  insertMessages(db, rows)
}

/** `pairs` complete request/response pairs strictly OUTSIDE the 24h window. */
function buildOutOfWindowPairs(pairs: number): Fixture {
  const entry = fixture()
  insertInWindowSet(entry.db, 20)
  const rows: MessageRow[] = []
  for (let i = 0; i < pairs; i++) {
    const requestTs = NOW - 30 * DAY - i * MINUTE
    rows.push({
      id: `old-req-${i}`,
      type: "request",
      sender: `@dev/${i % 12}`,
      recipient: "@chief",
      ts: requestTs,
      request: `old-${i}`,
    })
    rows.push({
      id: `old-res-${i}`,
      type: "response",
      sender: "@chief",
      recipient: `@dev/${i % 12}`,
      ts: requestTs + MINUTE,
      reply: `old-${i}`,
    })
  }
  entry.db.run("BEGIN")
  insertMessages(entry.db, rows)
  entry.db.run("COMMIT")
  entry.db.run("PRAGMA cache_size = 32")
  return entry
}

/** `count` request-bearing rows, outside the window and matching nothing. */
function buildUnmatchedRequests(count: number): Fixture {
  const entry = fixture()
  insertInWindowSet(entry.db, 20)
  const rows: MessageRow[] = []
  for (let i = 0; i < count; i++) {
    rows.push({
      id: `unmatched-req-${i}`,
      type: "request",
      sender: `@dev/${i % 12}`,
      recipient: "@chief",
      ts: NOW - 30 * DAY - i * MINUTE,
      request: `unmatched-${i}`,
    })
  }
  entry.db.run("BEGIN")
  insertMessages(entry.db, rows)
  entry.db.run("COMMIT")
  entry.db.run("PRAGMA cache_size = 32")
  return entry
}

describe("24284 response-latency projection is bounded by its window", () => {
  it("costs the same however large the out-of-window journal grows", () => {
    // Probe A. The in-window response set is identical (20 pairs); only the
    // out-of-window live+archive journal differs. Any growth is whole-journal
    // materialization.
    const lean = costPerCall(buildOutOfWindowPairs(200).db)
    const huge = costPerCall(buildOutOfWindowPairs(6_000).db)

    expect(huge).toBeLessThan(Math.max(lean, 1) * 1.5)
  })

  it("costs the same however many unmatched request keys the journal holds", () => {
    // Probe B. Isolates the request side: with the partial `request` index the
    // request half is a seek per in-window response; without it each response
    // scans the table and the cost tracks this growth.
    const lean = costPerCall(buildUnmatchedRequests(200).db)
    const huge = costPerCall(buildUnmatchedRequests(15_000).db)

    expect(huge).toBeLessThan(Math.max(lean, 1) * 1.5)
    expect(huge).toBeLessThan(500)
  })
})

describe("24284 response-latency projection keeps its answers", () => {
  it("returns exactly the rows the pre-fix journal join returned", () => {
    const { db } = fixture()
    insertSession(db, "@chief", "chief")
    insertMessages(db, [
      // Live/live, plus the old-request/new-response shape: the response is in
      // the window, the request it answers is not, and it must still pair.
      { id: "A-req", type: "request", sender: "@dev/1", recipient: "@chief", ts: NOW - 60 * MINUTE, request: "A" },
      {
        id: "A-res",
        type: "response",
        sender: "@chief",
        recipient: "@dev/1",
        ts: NOW - 50 * MINUTE,
        reply: "A",
      },
      {
        id: "C-req",
        type: "assign",
        sender: "@dev/3",
        recipient: "@chief",
        ts: NOW - 45 * MINUTE,
        request: "C",
        archive: true,
      },
      {
        id: "C-res",
        type: "response",
        sender: "@chief",
        recipient: "@dev/3",
        ts: NOW - 25 * MINUTE,
        reply: "C",
      },
      // Archive/archive.
      {
        id: "B-req",
        type: "query",
        sender: "@dev/2",
        recipient: "@chief",
        ts: NOW - 55 * MINUTE,
        request: "B",
        archive: true,
      },
      {
        id: "B-res",
        type: "response",
        sender: "@chief",
        recipient: "@dev/2",
        ts: NOW - 40 * MINUTE,
        reply: "B",
        archive: true,
      },
      // Duplicate request key in BOTH physical tables: one response must pair
      // with BOTH requests, i.e. two rows. A dual LEFT JOIN + COALESCE would
      // collapse them; this is the multiplicity the ruling requires preserved.
      { id: "D-req-live", type: "request", sender: "@dev/4", recipient: "@chief", ts: NOW - 30 * MINUTE, request: "D" },
      {
        id: "D-req-arch",
        type: "notify",
        sender: "@dev/4",
        recipient: "@chief",
        ts: NOW - 20 * MINUTE,
        request: "D",
        archive: true,
      },
      { id: "D-res", type: "response", sender: "@chief", recipient: "@dev/4", ts: NOW - 10 * MINUTE, reply: "D" },
      // Missing request: no row.
      {
        id: "E-res",
        type: "response",
        sender: "@chief",
        recipient: "@dev/4",
        ts: NOW - 5 * MINUTE,
        reply: "E-absent",
      },
      // Future response: outside the window, no row.
      { id: "F-req", type: "request", sender: "@dev/5", recipient: "@chief", ts: NOW - 50 * MINUTE, request: "F" },
      { id: "F-res", type: "response", sender: "@chief", recipient: "@dev/5", ts: NOW + 10 * MINUTE, reply: "F" },
      // Response OLDER than the request it answers: no row.
      { id: "G-req", type: "request", sender: "@dev/6", recipient: "@chief", ts: NOW - 5 * MINUTE, request: "G" },
      { id: "G-res", type: "response", sender: "@chief", recipient: "@dev/6", ts: NOW - 30 * MINUTE, reply: "G" },
      // Response outside the window: no row, even though its request is in it.
      { id: "H-req", type: "request", sender: "@dev/7", recipient: "@chief", ts: NOW - 50 * HOUR, request: "H" },
      { id: "H-res", type: "response", sender: "@chief", recipient: "@dev/7", ts: NOW - 25 * HOUR, reply: "H" },
      // Sender with no session row: COALESCE to role "unknown".
      { id: "I-req", type: "request", sender: "@ghost", recipient: "@chief", ts: NOW - 40 * MINUTE, request: "I" },
      { id: "I-res", type: "response", sender: "@ghost", recipient: "@chief", ts: NOW - 30 * MINUTE, reply: "I" },
    ])

    const expected: LatencyRow[] = [
      { role: "chief", sender: "@chief", message_type: "assign", latency_ms: 20 * MINUTE },
      { role: "chief", sender: "@chief", message_type: "notify", latency_ms: 10 * MINUTE },
      { role: "chief", sender: "@chief", message_type: "query", latency_ms: 15 * MINUTE },
      { role: "chief", sender: "@chief", message_type: "request", latency_ms: 10 * MINUTE },
      { role: "chief", sender: "@chief", message_type: "request", latency_ms: 20 * MINUTE },
      { role: "unknown", sender: "@ghost", message_type: "request", latency_ms: 10 * MINUTE },
    ]
    const oracle = db
      .query(assertSingleStatement(PRE_FIX_ORACLE_SQL))
      .all({ $cutoff: NOW - DAY, $now: NOW }) as LatencyRow[]

    const projection = responseLatencyProjection(db, NOW)
    expect(projection.rows).toEqual(expected)
    expect(oracle).toEqual(expected)

    expect(projection.summary).toEqual({
      as_of_ms: NOW,
      window_ms: DAY,
      count: 6,
      p50_ms: 10 * MINUTE,
      p95_ms: 20 * MINUTE,
      max_ms: 20 * MINUTE,
      by_role_and_type: [
        {
          role: "chief",
          message_type: "assign",
          count: 1,
          p50_ms: 20 * MINUTE,
          p95_ms: 20 * MINUTE,
          max_ms: 20 * MINUTE,
        },
        {
          role: "chief",
          message_type: "notify",
          count: 1,
          p50_ms: 10 * MINUTE,
          p95_ms: 10 * MINUTE,
          max_ms: 10 * MINUTE,
        },
        {
          role: "chief",
          message_type: "query",
          count: 1,
          p50_ms: 15 * MINUTE,
          p95_ms: 15 * MINUTE,
          max_ms: 15 * MINUTE,
        },
        {
          role: "chief",
          message_type: "request",
          count: 2,
          p50_ms: 10 * MINUTE,
          p95_ms: 20 * MINUTE,
          max_ms: 20 * MINUTE,
        },
        {
          role: "unknown",
          message_type: "request",
          count: 1,
          p50_ms: 10 * MINUTE,
          p95_ms: 10 * MINUTE,
          max_ms: 10 * MINUTE,
        },
      ],
    })
    expect(projection.warnings).toEqual([])
  })
})

describe("24284 request-key indexes reach an existing database", () => {
  it("migrates a v38 database to the new version and creates both partial indexes", () => {
    const entry = fixture()
    // Rewind the fixture to the shape a pre-24284 daemon would have opened:
    // version 38, neither request index present.
    entry.db.run("DROP INDEX IF EXISTS idx_messages_request")
    entry.db.run("DROP INDEX IF EXISTS idx_messages_archive_request")
    entry.db.run("UPDATE _schema_meta SET value = '38' WHERE key = 'version'")
    entry.db.close()

    entry.db = openDatabase(join(entry.dir, "tribe.db"))
    const version = entry.db.prepare("SELECT value FROM _schema_meta WHERE key = 'version'").get() as {
      value: string
    }
    const indexes = (
      entry.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_messages_request','idx_messages_archive_request') ORDER BY name",
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name)

    expect(version.value).toBe(String(CURRENT_SCHEMA_VERSION))
    expect(indexes).toEqual(["idx_messages_archive_request", "idx_messages_request"])
  })
})
