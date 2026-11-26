/**
 * @failure A wake inserted while a seat had no push transport is durable but never fanned out, so the
 *          row sits undelivered until the seat fetches for an unrelated reason and fleet health calls it
 *          "never written to its socket" the whole time.
 * @level L2
 * @consumer withBroadcast's attach path and every push seat that reconnects holding a wake
 * @testonly none
 *
 * Two halves, because they fail differently: the reading (what the seat was never handed) is SQL over the
 * journal, and the attach path (one wakeup, cursor advanced, filter respected) is wiring in withBroadcast.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { Database } from "bun:sqlite"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { readCatchUp } from "./catch-up-on-attach.ts"
import { withBroadcast } from "./compose/with-broadcast.ts"
import { createStatements, openDatabase } from "./database.ts"

const SESSION_ID = "session-1"
const NAME = "@seat"
const OTHER = "@other"

let dir: string
let db: Database

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "catch-up-on-attach-"))
  db = openDatabase(join(dir, "tribe.db"))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function seat(options: { delivery?: "push" | "pull"; cursor?: number; filterMode?: string } = {}): void {
  db.prepare(
    `INSERT INTO sessions (id, name, role, pid, started_at, updated_at, delivery, last_delivered_seq, filter_mode)
     VALUES (?, ?, 'member', 1, 0, 0, ?, ?, ?)`,
  ).run(SESSION_ID, NAME, options.delivery ?? "push", options.cursor ?? 0, options.filterMode ?? "normal")
}

function row(options: {
  id: string
  type?: string
  kind?: string
  sender?: string
  recipient?: string
  delivery?: "push" | "pull"
  wakesOwner?: 0 | 1
  settlesOwn?: boolean
}): number {
  db.prepare(
    `INSERT INTO messages (id, type, sender, recipient, kind, content, ts, delivery, wakes_owner, correlated_reply_requester)
     VALUES (?, ?, ?, ?, ?, 'body', 1000, ?, ?, ?)`,
  ).run(
    options.id,
    options.type ?? "notify",
    options.sender ?? "@chief",
    options.recipient ?? NAME,
    options.kind ?? "direct",
    options.delivery ?? "push",
    options.wakesOwner ?? 0,
    options.settlesOwn === true ? NAME : null,
  )
  return (db.prepare("SELECT rowid FROM messages WHERE id = ?").get(options.id) as { rowid: number }).rowid
}

describe("readCatchUp", () => {
  it("counts only rows this seat was never handed, and names the newest", () => {
    seat({ cursor: 0 })
    row({ id: "handed", delivery: "push" }) // rowid 1
    db.prepare("UPDATE sessions SET last_delivered_seq = 1 WHERE id = $id").run({ $id: SESSION_ID })
    const unread = row({ id: "unread" }) // rowid 2
    row({ id: "pull-row", delivery: "pull" }) // never fanned out by design
    row({ id: "event-row", kind: "event" }) // journal-only
    row({ id: "own-copy", sender: NAME }) // the seat's own send
    row({ id: "someone-else", recipient: OTHER })

    const reading = readCatchUp(db, SESSION_ID, NAME)
    expect(reading.rows).toBe(1)
    expect(reading.newest?.id).toBe("unread")
    expect(reading.newest?.rowid).toBe(unread)
  })

  it("has nothing to catch up for a pull seat", () => {
    seat({ delivery: "pull" })
    row({ id: "waiting" })
    expect(readCatchUp(db, SESSION_ID, NAME)).toEqual({ rows: 0, newest: null, anyActionable: false })
  })

  it("treats a broadcast row addressed to everyone as undelivered", () => {
    seat()
    const broadcast = row({ id: "to-all", recipient: "*", sender: "@chief" })
    const reading = readCatchUp(db, SESSION_ID, NAME)
    expect(reading.rows).toBe(1)
    expect(reading.newest?.rowid).toBe(broadcast)
  })

  it("marks an actionable type, an owner-waking edge and a settling reply, and nothing quiet", () => {
    seat()
    row({ id: "quiet", type: "notify" })
    expect(readCatchUp(db, SESSION_ID, NAME).anyActionable).toBe(false)

    row({ id: "request", type: "request" })
    expect(readCatchUp(db, SESSION_ID, NAME).anyActionable).toBe(true)
  })

  it("reads the owner-waking edge even when its type is quiet", () => {
    seat()
    row({ id: "edge", type: "incident", wakesOwner: 1 })
    expect(readCatchUp(db, SESSION_ID, NAME).anyActionable).toBe(true)
  })

  it("reads a row that settles this seat's own request", () => {
    seat()
    row({ id: "answer", type: "response", settlesOwn: true })
    expect(readCatchUp(db, SESSION_ID, NAME).newest?.settlesOwnRequest).toBe(true)
  })

  it("counts every waiting row, not only the one the wakeup names", () => {
    seat()
    for (let i = 0; i < 60; i++) row({ id: `waiting-${i}` })
    const reading = readCatchUp(db, SESSION_ID, NAME)
    expect(reading.rows).toBe(60)
    expect(reading.newest?.id).toBe("waiting-59")
  })
})

type Written = { connId: string; payload: string }

function attachHarness() {
  const written: Written[] = []
  const clients = new Map<string, unknown>()
  const socket = {
    destroyed: false,
    writable: true,
    write(payload: string) {
      written.push({ connId: "conn-1", payload })
      return true
    },
  }
  clients.set("conn-1", {
    name: NAME,
    role: "member",
    delivery: "push",
    socket,
    ctx: { sessionId: SESSION_ID },
  })
  let changed: ((sessionId: string) => void) | undefined
  const registry = {
    clients: clients as ReadonlyMap<string, { ctx: { sessionId: string } }>,
    isPushTransport: (connId: string) => connId === "conn-1",
    onTransportsChanged: (listener: (sessionId: string) => void) => {
      changed = listener
      return () => {
        changed = undefined
      }
    },
  }
  const stmts = createStatements(db)
  const daemonCtx = { onMessageInserted: undefined as unknown }
  const tribe = withBroadcast()({
    scope: { defer: () => {} },
    daemonSessionId: "daemon-test",
    startedAt: 0,
    daemonVersion: "test",
    daemonPid: 1,
    db,
    stmts,
    daemonCtx,
    registry,
  } as never)
  return {
    written,
    tribe,
    attach: () => {
      if (changed === undefined) throw new Error("the attach path never subscribed to transport changes")
      changed(SESSION_ID)
    },
  }
}

describe("attach path", () => {
  const previousBatch = process.env.TRIBE_BROADCAST_BATCH_MS
  beforeEach(() => {
    process.env.TRIBE_BROADCAST_BATCH_MS = "0"
  })
  afterEach(() => {
    if (previousBatch === undefined) delete process.env.TRIBE_BROADCAST_BATCH_MS
    else process.env.TRIBE_BROADCAST_BATCH_MS = previousBatch
  })

  it("writes one wakeup naming the newest undelivered row and advances the cursor", async () => {
    seat()
    const newest = row({ id: "waiting", type: "request" })
    const harness = attachHarness()
    expect(harness.tribe.broadcast).toBeDefined()

    harness.attach()
    await Promise.resolve()

    expect(harness.written, "one wakeup, not one per row").toHaveLength(1)
    expect(harness.written[0]?.payload).toContain(String(newest))
    const cursor = db.prepare("SELECT last_delivered_seq FROM sessions WHERE id = $id").get({
      $id: SESSION_ID,
    }) as { last_delivered_seq: number }
    expect(cursor.last_delivered_seq).toBe(newest)
  })

  it("stays quiet on the second change when the seat already has its push transport", async () => {
    seat()
    row({ id: "waiting", type: "request" })
    const harness = attachHarness()
    harness.attach()
    await Promise.resolve()
    expect(harness.written).toHaveLength(1)

    harness.attach()
    await Promise.resolve()
    expect(harness.written, "only the false→true edge may catch up").toHaveLength(1)
  })

  it("does not wake a focus seat for a quiet row", async () => {
    seat({ filterMode: "focus" })
    row({ id: "quiet", type: "notify" })
    const harness = attachHarness()
    harness.attach()
    await Promise.resolve()
    expect(harness.written).toHaveLength(0)
  })

  it("does not catch up for a pull seat even with rows waiting", async () => {
    seat({ delivery: "pull" })
    row({ id: "waiting", type: "request" })
    const harness = attachHarness()
    harness.attach()
    await Promise.resolve()
    expect(harness.written).toHaveLength(0)
  })
})
