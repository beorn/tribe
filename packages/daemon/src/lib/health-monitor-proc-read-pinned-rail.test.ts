/**
 * @failure  The proc-read-pinned tick reached no one: its incident subject carried a Linux start time's ":", the
 *           daemon's sendMessage refused the key, and every raise threw while the pure-function rows stayed green
 *           (24248, review-adhoc5 dc27b86b). Only the real rail shows whether a raise becomes a ball @chief owns.
 * @level    l2 — the real runProcReadPinnedTick against a real database, sendMessage and ball tracker, wired as
 *           compose/with-runtime.ts wires the plugin API.
 * @consumer the proc-read-pinned incident @chief receives from the health monitor
 * @testonly none
 */

import type { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createTribeContext } from "./context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import {
  PROC_READ_PINNED_AFTER_MS,
  PROC_READ_PINNED_CONDITION,
  PROC_READ_PINNED_EMITTER,
  PROC_READ_PINNED_OWNER,
  runProcReadPinnedTick,
} from "./health-monitor-plugin.ts"
import type { CanonicalProcessObservation } from "./health-process-source.ts"
import { readOpenIncidents, sendMessage } from "./messaging.ts"
import type { TribeClientApi } from "./plugin-api.ts"

const since = "2026-09-24T12:00:00.000Z"
const sinceMs = Date.parse(since)
// The production incarnation shape, inhab's formatLinuxProcessStartTime: linux:<boot id>:<ticks>.
const read = { path: "/proc/80/environ", pid: 80, since, startTime: "linux:fae19c69-b17e-45ca-ae56-60eb669072e5:4242" }

function incomplete(reads: readonly (typeof read)[]): CanonicalProcessObservation {
  return {
    diagnostic: {
      detail: "error on 1 rows",
      excluded: ["standalone-os-resample", "cross-batch-attribution", "implicit-unowned"],
      location: "/hab/habmod",
      query: "latest exact process census with owner attribution",
    },
    kind: "unavailable",
    pendingProcReads: { budget: 16, reads },
    reason: "process-census-incomplete",
    schema: "process-observation/1",
  }
}

describe("proc-read-pinned on the daemon's real incident rail", () => {
  let dir: string
  let db: Database
  let stmts: TribeStatements

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "proc-read-pinned-rail-"))
    db = openDatabase(join(dir, "tribe.db"))
    stmts = createStatements(db)
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { force: true, recursive: true })
  })

  /** with-runtime.ts's send and listOpenIncidents; every other member is unused by this tick and refuses loudly. */
  function daemonApi(): TribeClientApi {
    const daemonCtx = createTribeContext({
      claudeSessionId: null,
      claudeSessionName: null,
      db,
      domains: [],
      initialName: "daemon",
      sessionId: "sess-daemon",
      sessionRole: "member",
      stmts,
    })
    const unused = (): never => {
      throw new Error("not used by the proc-read-pinned tick")
    }
    return {
      broadcast: unused,
      claimDedup: unused,
      getActiveSessions: unused,
      getSessionNames: unused,
      getUnreadDms: unused,
      hasRecentMessage: unused,
      listOpenIncidents: (emitter, condition) => readOpenIncidents(stmts, emitter, condition),
      send(recipient, content, type, beadId, classification, incident) {
        sendMessage(
          daemonCtx,
          recipient,
          content,
          type,
          beadId,
          undefined,
          recipient === "*" ? "broadcast" : "direct",
          classification ?? {},
          incident === undefined ? {} : { incident },
        )
      },
    } as TribeClientApi
  }

  const messageCount = (): number => (db.query("SELECT count(*) AS n FROM messages").get() as { n: number }).n
  const ballsFor = (recipient: string): string[] =>
    (stmts.selectPendingForRecipient.all({ $recipient: recipient }) as Array<{ request_id: string }>).map(
      (row) => row.request_id,
    )
  const openIncidents = () => readOpenIncidents(stmts, PROC_READ_PINNED_EMITTER, PROC_READ_PINNED_CONDITION)

  it("a production-shaped read at the threshold opens exactly one ball, owned by @chief", () => {
    runProcReadPinnedTick(daemonApi(), incomplete([read]), new Map(), sinceMs + PROC_READ_PINNED_AFTER_MS)

    expect(openIncidents()).toEqual([expect.objectContaining({ recipient: PROC_READ_PINNED_OWNER })])
    expect(ballsFor(PROC_READ_PINNED_OWNER)).toHaveLength(1)
    expect(messageCount()).toBe(1)
  })

  it("a second tick on the same condition line sends nothing", () => {
    const api = daemonApi()
    const told = new Map<string, string>()
    runProcReadPinnedTick(api, incomplete([read]), told, sinceMs + PROC_READ_PINNED_AFTER_MS)
    runProcReadPinnedTick(api, incomplete([read]), told, sinceMs + PROC_READ_PINNED_AFTER_MS + 60_000)

    expect(messageCount()).toBe(1)
    expect(ballsFor(PROC_READ_PINNED_OWNER)).toHaveLength(1)
  })

  it("a census without the read clears the ball", () => {
    const api = daemonApi()
    const told = new Map<string, string>()
    runProcReadPinnedTick(api, incomplete([read]), told, sinceMs + PROC_READ_PINNED_AFTER_MS)
    runProcReadPinnedTick(api, incomplete([]), told, sinceMs + PROC_READ_PINNED_AFTER_MS + 30_000)

    expect(openIncidents()).toEqual([])
    expect(ballsFor(PROC_READ_PINNED_OWNER)).toEqual([])
    expect(told.size).toBe(0)
  })
})
