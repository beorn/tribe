/**
 * The attention projection must cost O(one seat's own tail), never
 * O(whole journal) and never O(seat history x counterpart's sent history)
 * — pre-fix RED.
 *
 * Measured on a copy of the live 105MB journal (105,167 messages, 36,635 of
 * them direct, @chief holding 31,345 received): ONE `inbox_wait` for @chief
 * cost the daemon 590,084 read syscalls, 2,059 MB of page reads and 326 ms of
 * CPU. The live daemon sat at ~623,000 read syscalls/second — about one such
 * call per second — and burned two thirds of a core continuously, from the
 * first minute after start.
 *
 * Two independent defects produced that, and this file pins both:
 *
 *  1. `unretiredAttentionPredicateSql` is a correlated NOT EXISTS keyed on
 *     (sender, recipient, reply). No index led with those columns, so the only
 *     candidate was idx_messages_sender(sender), and EVERY outer candidate row
 *     re-scanned everything its counterpart had ever sent. That is the
 *     quadratic term, and it is why the busiest seat was the slowest.
 *
 *  2. No index led on `recipient` while preserving rowid order, so the planner
 *     drove the outer loop off idx_messages_kind_ts(kind) — a walk of every
 *     direct message in the journal — and sorted the survivors through a temp
 *     B-tree, leaving `ORDER BY rowid DESC LIMIT 1` unable to short-circuit. A
 *     seat with NO mail paid the same full walk as the busiest one.
 *
 * Each defect gets a probe that isolates ITS growth term, because a single
 * end-to-end cost assertion cannot say which one regressed:
 *
 *   Probe A holds the seat's received history fixed and grows only the
 *   counterpart's SENT history. Correct cost is flat; the quadratic plan
 *   tracks the growth.
 *
 *   Probe B asks for a seat with no mail at all and grows only OTHER seats'
 *   traffic. Correct cost is zero; the whole-journal plan tracks the journal.
 *
 * Both are measured in read syscalls rather than wall time, because syscalls
 * are exact and wall time is not. `PRAGMA cache_size` is pinned small so the
 * counter reflects pages VISITED: with the default 2MB cache a fixture this
 * size sits entirely in memory and every plan, correct or quadratic, reports
 * zero reads — an instrument that cannot fail is not a gate.
 */

import { mkdtempSync, rmSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Database } from "bun:sqlite"

import { createStatements, openDatabase, type TribeStatements } from "./database.ts"

/** Busy coordinator seat — the shape that made the live daemon quadratic. */
const HUB = "@chief"

/**
 * Pages this process has read so far.
 *
 * SQLite serves every page it does not already hold through a pread, so with a
 * small cache this counts pages the statement visited.
 */
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

type Fixture = { db: Database; stmts: TribeStatements; dir: string }
const open: Fixture[] = []

/**
 * Build a journal: `received` settled request/response pairs addressed to the
 * hub, plus `sent` unrelated messages FROM the hub. Every request is answered,
 * so the projection's correct answer is "nothing actionable" — which forces it
 * to walk, and makes any excess walking visible.
 */
function buildJournal(received: number, sent: number): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "tribe-attention-scan-"))
  const db = openDatabase(join(dir, "tribe.db"))
  const insert = db.prepare(
    `INSERT INTO messages (id, type, sender, recipient, kind, content, ts, request, reply)
     VALUES ($id, $type, $sender, $recipient, 'direct', $content, $ts, $request, $reply)`,
  )

  db.run("BEGIN")
  for (let i = 0; i < received; i++) {
    const peer = `@dev/${i % 12}`
    insert.run({
      $id: `req-${i}`,
      $type: "request",
      $sender: peer,
      $recipient: HUB,
      $content: `request ${i}`,
      $ts: 1_000 + i,
      $request: `req-${i}`,
      $reply: null,
    })
    insert.run({
      $id: `rep-${i}`,
      $type: "response",
      $sender: HUB,
      $recipient: peer,
      $content: `reply ${i}`,
      $ts: 1_000 + i,
      $request: null,
      $reply: `req-${i}`,
    })
  }
  for (let i = 0; i < sent; i++) {
    insert.run({
      $id: `chat-${i}`,
      $type: "notify",
      $sender: HUB,
      $recipient: `@dev/${i % 12}`,
      $content: `chatter ${i}`,
      $ts: 50_000 + i,
      $request: null,
      $reply: null,
    })
  }
  db.run("COMMIT")

  // See the header: a cache large enough to hold the fixture makes the read
  // counter report zero for every plan.
  db.run("PRAGMA cache_size = 32")

  const fixture = { db, stmts: createStatements(db), dir }
  open.push(fixture)
  return fixture
}

/** Read syscalls the dispatcher's inbox-wait statement costs for one session. */
function costPerCall(stmts: TribeStatements, session: string): number {
  const run = () =>
    stmts.getLatestInboxWaitMessage.get({
      $name: session,
      $include_correlated_replies: 0,
      $unacknowledged_only: 0,
    })

  run() // settle the prepared-statement and schema pages first
  const before = readSyscalls()
  const iterations = 10
  for (let i = 0; i < iterations; i++) run()
  return (readSyscalls() - before) / iterations
}

/** The plan for the very statement the dispatcher calls — never a hand copy. */
function planFor(fixture: Fixture, session: string): string {
  const sql = (fixture.stmts.getLatestInboxWaitMessage as unknown as { toString(): string }).toString()
  const rows = fixture.db
    .query(`EXPLAIN QUERY PLAN ${sql}`)
    .all({ $name: session, $include_correlated_replies: 0, $unacknowledged_only: 0 }) as { detail: string }[]
  return rows.map((row) => row.detail).join("\n")
}

afterEach(() => {
  for (const fixture of open.splice(0)) {
    fixture.db.close()
    rmSync(fixture.dir, { recursive: true, force: true })
  }
})

describe("attention projection resolves retirement through an index", () => {
  it("does not rescan the counterpart's sent history", () => {
    const plan = planFor(buildJournal(200, 200), HUB)

    // idx_messages_sender as the subquery's index IS the quadratic plan: it
    // means "scan everything this sender ever sent", once per candidate row.
    expect(plan).toContain("idx_messages_reply_retire")
    expect(plan).not.toContain("idx_messages_sender")
  })

  it("costs the same no matter how much the counterpart has sent", () => {
    // Probe A. Received history is identical in both journals; only the hub's
    // own sent volume differs. The retirement check is the only thing that
    // reads sent history, so any growth here is defect 1.
    const lean = costPerCall(buildJournal(1_500, 250).stmts, HUB)
    const chatty = costPerCall(buildJournal(1_500, 8_000).stmts, HUB)

    expect(chatty).toBeLessThan(Math.max(lean, 1) * 1.5)
  })
})

describe("attention projection drives off the recipient, not the whole journal", () => {
  it("does not walk every direct message to answer one seat", () => {
    const plan = planFor(buildJournal(200, 200), HUB)

    expect(plan).not.toContain("idx_messages_kind_ts")
    expect(plan).toContain("idx_messages_recipient_kind")

    // A temp B-tree means LIMIT 1 cannot short-circuit: SQLite materialises and
    // sorts every match before taking one.
    expect(plan).not.toContain("USE TEMP B-TREE")
  })

  it("costs a seat with no mail nothing, however large the journal", () => {
    // Probe B. The sharpest case: the answer is reachable without visiting a
    // single row, so every read here is journal scanning.
    const small = costPerCall(buildJournal(500, 500).stmts, "@seat-with-no-mail")
    const large = costPerCall(buildJournal(5_000, 5_000).stmts, "@seat-with-no-mail")

    expect(small).toBeLessThan(20)
    expect(large).toBeLessThan(20)
  })
})

describe("attention projection keeps its answers", () => {
  it("returns the newest unretired actionable message", () => {
    // Bounding the work is only correct if the answer is unchanged: an
    // unanswered assign landing after all the settled history must win.
    const { db, stmts } = buildJournal(300, 300)
    db.run(
      `INSERT INTO messages (id, type, sender, recipient, kind, content, ts, request)
       VALUES ('live-1', 'assign', '@cto', $hub, 'direct', 'do the thing', 99000, 'live-1')`,
      { $hub: HUB } as never,
    )

    const row = stmts.getLatestInboxWaitMessage.get({
      $name: HUB,
      $include_correlated_replies: 0,
      $unacknowledged_only: 0,
    }) as { rowid: number } | undefined
    const expected = db.query("SELECT rowid FROM messages WHERE id = 'live-1'").get() as { rowid: number }

    expect(row?.rowid).toBe(expected.rowid)
  })

  it("treats a replied-to request as retired", () => {
    // Retirement semantics are what the subquery exists for; an index that
    // changed them would be a correctness regression wearing a speedup's coat.
    const { db, stmts } = buildJournal(300, 300)
    const latest = () =>
      stmts.getLatestInboxWaitMessage.get({
        $name: HUB,
        $include_correlated_replies: 0,
        $unacknowledged_only: 0,
      }) as { rowid: number } | undefined

    db.run(
      `INSERT INTO messages (id, type, sender, recipient, kind, content, ts, request)
       VALUES ('open-1', 'request', '@cto', $hub, 'direct', 'answer me', 98000, 'open-1')`,
      { $hub: HUB } as never,
    )
    const openRow = db.query("SELECT rowid FROM messages WHERE id = 'open-1'").get() as { rowid: number }
    expect(latest()?.rowid).toBe(openRow.rowid)

    db.run(
      `INSERT INTO messages (id, type, sender, recipient, kind, content, ts, reply)
       VALUES ('answer-1', 'response', $hub, '@cto', 'direct', 'answered', 98500, 'open-1')`,
      { $hub: HUB } as never,
    )
    expect(latest()?.rowid).not.toBe(openRow.rowid)
  })
})
