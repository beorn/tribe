/**
 * @km/tribe/21753 — the db-backed `getStaleBalls()` plugin-api method that the
 * health monitor's PASSIVE stale-ball watchdog reads. It is the ONE place the
 * broadcast rail learns which owners breach the ball SLA, so it must group by
 * owner, honour the configurable threshold, and never fabricate a breach.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createStatements, openDatabase, type TribeStatements } from "../database.ts"
import { defaultBuildPluginApi } from "./with-runtime.ts"

const MINUTE = 60_000

function openBall(stmts: TribeStatements, o: { id: string; recipient: string; openedAt: number }): void {
  stmts.openPendingRequest.run({
    $request_id: o.id,
    $recipient: o.recipient,
    $sender: "@chief",
    $opened_at: o.openedAt,
    $expires_at: null,
    $message_id: `${o.id}-msg`,
    $fanout: "first",
  })
}

/** Build the real plugin api over a live db. getStaleBalls only closes over
 *  `stmts`, so the daemonCtx / registry / broadcast members are unused stubs. */
function buildApi(stmts: TribeStatements) {
  return defaultBuildPluginApi({
    stmts,
    daemonCtx: {},
    daemonSessionId: "daemon",
    registry: { clients: new Map() },
  } as unknown as Parameters<typeof defaultBuildPluginApi>[0])
}

describe("getStaleBalls (@km/tribe/21753)", () => {
  let tmpDir: string
  let db: ReturnType<typeof openDatabase>
  let stmts: TribeStatements
  const savedSla = process.env.TRIBE_BALL_SLA_MS

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "stale-balls-"))
    db = openDatabase(join(tmpDir, "tribe.db"))
    stmts = createStatements(db)
    delete process.env.TRIBE_BALL_SLA_MS
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
    if (savedSla === undefined) delete process.env.TRIBE_BALL_SLA_MS
    else process.env.TRIBE_BALL_SLA_MS = savedSla
  })

  it("groups balls past the default 10m threshold by owner, sorted, with the oldest age", () => {
    const now = Date.now()
    // @agent/8: two stale (30m, 15m) + one fresh (1m) → count 2, oldest 30m.
    openBall(stmts, { id: "a8-old", recipient: "@agent/8", openedAt: now - 30 * MINUTE })
    openBall(stmts, { id: "a8-mid", recipient: "@agent/8", openedAt: now - 15 * MINUTE })
    openBall(stmts, { id: "a8-fresh", recipient: "@agent/8", openedAt: now - 1 * MINUTE })
    // @agent/1: one stale (12m).
    openBall(stmts, { id: "a1", recipient: "@agent/1", openedAt: now - 12 * MINUTE })
    // @ci: only fresh (2m) → not stale, absent.
    openBall(stmts, { id: "ci-fresh", recipient: "@ci", openedAt: now - 2 * MINUTE })

    const { thresholdMs, owners } = buildApi(stmts).getStaleBalls()

    expect(thresholdMs).toBe(10 * MINUTE)
    expect(owners.map((o) => o.owner)).toEqual(["@agent/1", "@agent/8"])
    const a8 = owners.find((o) => o.owner === "@agent/8")!
    expect(a8.count).toBe(2)
    expect(a8.oldestAgeMs).toBeGreaterThanOrEqual(30 * MINUTE)
    expect(owners.find((o) => o.owner === "@agent/1")!.count).toBe(1)
  })

  it("honours the TRIBE_BALL_SLA_MS override — a raised threshold clears the breach", () => {
    const now = Date.now()
    openBall(stmts, { id: "b", recipient: "@agent/2", openedAt: now - 12 * MINUTE })

    process.env.TRIBE_BALL_SLA_MS = String(20 * MINUTE)
    const { thresholdMs, owners } = buildApi(stmts).getStaleBalls()

    expect(thresholdMs).toBe(20 * MINUTE)
    expect(owners).toEqual([]) // 12m < 20m → no breach
  })

  it("returns no owners when nothing breaches (never a fabricated stale owner)", () => {
    const now = Date.now()
    openBall(stmts, { id: "fresh", recipient: "@agent/3", openedAt: now - 1 * MINUTE })

    const { owners } = buildApi(stmts).getStaleBalls()
    expect(owners).toEqual([])
  })
})
