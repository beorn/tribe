/**
 * 24604 (a): a same-name registration and a live durable-launch row (@cto cdb79aad, option B).
 *
 * Specimen: post-merge-tests run e56f5c4e held "post-merge-tests" for four hours. At 15:10Z its transport was
 * inactive, a hab timer tick registered the same name, and registration deleted the run's row. The run's own sends
 * at 16:42Z then resolved its launch to "0 stored". The rule: a durable-launch row belongs to its launch; only the
 * same launch id, or a parent proven dead, replaces it, and an inactive transport is never proof of death.
 */
import { Database } from "bun:sqlite"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createTribeContext, type TribeContext } from "./context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { DurableLaunchHolderError, registerSession } from "./session.ts"
import { readProcessStartTime } from "./session-transport-state.ts"

const NAME = "post-merge-tests"

describe("registration and a durable-launch holder (24604 a)", () => {
  let tmpDir: string
  let db: Database
  let stmts: TribeStatements

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "registration-durable-holder-"))
    db = openDatabase(join(tmpDir, "tribe.db"))
    stmts = createStatements(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function register(sessionId: string, launchId: string, launchParentPid: number): TribeContext {
    const ctx = createTribeContext({
      db,
      stmts,
      sessionId,
      sessionRole: "member",
      initialName: NAME,
      domains: ["service"],
      claudeSessionId: null,
      claudeSessionName: null,
    })
    // No transport is active: the holder is between its sends, as the specimen's run was at 15:10Z.
    registerSession(
      ctx,
      "p",
      () => false,
      null,
      launchParentPid,
      "pull",
      "/repo",
      null,
      null,
      launchId,
      launchParentPid,
    )
    return ctx
  }

  const rowOf = (sessionId: string) => db.prepare("SELECT id, name FROM sessions WHERE id = ?").get(sessionId)
  const startTimeOf = (sessionId: string) =>
    (
      db.prepare("SELECT launch_parent_start_time AS t FROM sessions WHERE id = ?").get(sessionId) as {
        t: string | null
      }
    ).t
  const departures = () =>
    (
      db.prepare("SELECT content, ref FROM messages WHERE type = 'event.session.left'").all() as Array<{
        content: string
        ref: string
      }>
    ).map((row) => ({ ref: row.ref, ...(JSON.parse(row.content) as { reason: string; launch_id: string }) }))

  it("keeps a live durable holder from another launch, naming its pid, launch and the cure", () => {
    register("run", "run-launch::post-merge-tests", process.pid)
    expect(startTimeOf("run")).toBe(readProcessStartTime(process.pid))
    const tick = () => register("tick", "tick-launch::post-merge-tests", process.pid)
    expect(tick).toThrow(DurableLaunchHolderError)
    expect(tick).toThrow(
      `Name "${NAME}" belongs to launch run-launch::post-merge-tests, whose parent process ${process.pid} is alive ` +
        "(same start time). Its session is between connections, not gone. Stop that process or wait for it to exit, " +
        "then register again.",
    )
    expect(rowOf("run")).toEqual({ id: "run", name: NAME })
    expect(departures()).toEqual([])
  })

  it("the same launch id replaces the row, and journals the departure", () => {
    register("first", "run-launch::post-merge-tests", process.pid)
    register("second", "run-launch::post-merge-tests", process.pid)
    expect(rowOf("first")).toBeNull()
    expect(rowOf("second")).toEqual({ id: "second", name: NAME })
    expect(departures()).toEqual([
      expect.objectContaining({
        ref: "first",
        reason: "replaced-by-same-launch",
        launch_id: "run-launch::post-merge-tests",
      }),
    ])
  })

  it("a dead launch parent yields the name, and the departure is journaled", () => {
    const exited = spawnSync("true").pid ?? 0
    expect(exited).toBeGreaterThan(0)
    register("run", "run-launch::post-merge-tests", exited)
    register("tick", "tick-launch::post-merge-tests", process.pid)
    expect(rowOf("run")).toBeNull()
    expect(rowOf("tick")).toEqual({ id: "tick", name: NAME })
    expect(departures()).toEqual([expect.objectContaining({ ref: "run", reason: "replaced-parent-gone" })])
  })

  it("a reused pid, alive but with another start time, yields the name", () => {
    register("run", "run-launch::post-merge-tests", process.pid)
    db.prepare("UPDATE sessions SET launch_parent_start_time = '1' WHERE id = 'run'").run()
    register("tick", "tick-launch::post-merge-tests", process.pid)
    expect(rowOf("run")).toBeNull()
    expect(departures()).toEqual([expect.objectContaining({ ref: "run", reason: "replaced-parent-gone" })])
  })

  it("a holder the registrant displaced by its own authority (takeover) is replaced, and journaled as such", () => {
    register("run", "run-launch::post-merge-tests", process.pid)
    const ctx = createTribeContext({
      db,
      stmts,
      sessionId: "respawn",
      sessionRole: "member",
      initialName: NAME,
      domains: ["service"],
      claudeSessionId: null,
      claudeSessionName: null,
    })
    registerSession(
      ctx,
      "p",
      () => false,
      null,
      process.pid,
      "pull",
      "/repo",
      null,
      null,
      "respawn-launch::x",
      process.pid,
      null,
      new Set(["run"]),
    )
    expect(rowOf("run")).toBeNull()
    expect(departures()).toEqual([expect.objectContaining({ ref: "run", reason: "replaced-by-displacement" })])
  })

  it("a row without a start time is judged by pid alone, and the refusal says so", () => {
    register("run", "run-launch::post-merge-tests", process.pid)
    db.prepare("UPDATE sessions SET launch_parent_start_time = NULL WHERE id = 'run'").run()
    expect(() => register("tick", "tick-launch::post-merge-tests", process.pid)).toThrow(
      /is alive \(compared by pid only: the row predates start times, so a reused pid also reads alive\)/u,
    )
    expect(rowOf("run")).toEqual({ id: "run", name: NAME })
  })
})
