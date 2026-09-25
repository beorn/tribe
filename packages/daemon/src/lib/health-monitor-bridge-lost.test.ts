/**
 * A lost bridge pages its owner (25662, @cto shape ruling 430ba377).
 *
 * The 2026-09-24 loss: @chief's and @dev/3's MCP bridges died at 08:13 PDT and
 * stayed dead 4h58m. The only alert was checkChiefAbsent, a broadcast to "*"
 * that nobody owed and that cleared when @chief's unread count reached zero,
 * so reading over the CLI silenced it while the bridge stayed dead.
 *
 * The check under test reads transport state only: a seat hab expects up whose
 * transport is gone. It opens ONE incident per seat to the first configured
 * owner that is not itself lost, and clears it from the durable ball tracker
 * (never from memory) when the transport is live again or the seat exited.
 */

import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { RELOAD_DEADLINE_MS } from "tribe-wire/lib/reload-pacing"
import { createTribeContext } from "./context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { readOpenIncidents, sendMessage } from "./messaging.ts"
import type { TribeClientApi } from "./plugin-api.ts"
import {
  BRIDGE_LOST_CONDITION,
  BRIDGE_LOST_EMITTER,
  checkBridgeLost,
  parseBridgeLostConfig,
  runBridgeLostTick,
  type BridgeLostConfig,
  type BridgeLostFacts,
  type BridgeLostMemory,
} from "./health-monitor-plugin.ts"

const MIN = 60_000
const T0 = 1_000_000_000
const CONFIG: BridgeLostConfig = { owners: ["@chief", "@cto", "@adhoc/0"], graceMs: 3 * MIN }

function facts(over: Partial<BridgeLostFacts> = {}): BridgeLostFacts {
  return { missing: [], connected: new Set(), exited: new Map(), openIncidents: [], ...over }
}

const lost = (name: string, launchParentPid = 4242) => ({ name, launchParentPid })

/** In-memory grace clocks only; the open-incident set always comes from the durable tracker (facts). */
function memory(seen: ReadonlyArray<readonly [string, number]> = []): BridgeLostMemory {
  return { firstSeen: new Map(seen), broadcast: new Set() }
}

describe("checkBridgeLost", () => {
  test("a seat missing-transport pages only once the grace has passed, once per incident", () => {
    const firstSeen = memory()
    const lostDev = facts({ missing: [lost("@dev/3")] })

    expect(checkBridgeLost(lostDev, T0, firstSeen, CONFIG)).toEqual([])
    expect(checkBridgeLost(lostDev, T0 + 3 * MIN - 1, firstSeen, CONFIG)).toEqual([])

    const [page, ...rest] = checkBridgeLost(lostDev, T0 + 3 * MIN, firstSeen, CONFIG)
    expect(rest).toEqual([])
    expect(page).toMatchObject({
      kind: "raise",
      recipient: "@chief",
      incident: { emitter: BRIDGE_LOST_EMITTER, subject: "@dev/3", condition: BRIDGE_LOST_CONDITION },
    })
    expect(page?.content).toMatch(/@dev\/3.*bridge.*lost 3 min.*launch parent 4242.*\/mcp.*Reconnect/su)

    // The tracker already holds it: the next tick opens nothing new.
    const held = facts({ missing: [lost("@dev/3")], openIncidents: [{ subject: "@dev/3", recipient: "@chief" }] })
    expect(checkBridgeLost(held, T0 + 4 * MIN, firstSeen, CONFIG)).toEqual([])
  })

  test("@chief's own bridge pages the next owner, and a lost owner is skipped", () => {
    const chiefLost = facts({ missing: [lost("@chief")] })
    expect(checkBridgeLost(chiefLost, T0, memory([["@chief", T0 - CONFIG.graceMs]]), CONFIG)).toMatchObject([
      { kind: "raise", recipient: "@cto", incident: { subject: "@chief" } },
    ])

    const both = facts({ missing: [lost("@chief"), lost("@cto")] })
    const seen = memory([
      ["@chief", T0 - CONFIG.graceMs],
      ["@cto", T0 - CONFIG.graceMs],
    ])
    expect(checkBridgeLost(both, T0, seen, CONFIG).map((a) => [a.kind, a.recipient, a.incident?.subject])).toEqual([
      ["raise", "@adhoc/0", "@chief"],
      ["raise", "@adhoc/0", "@cto"],
    ])
  })

  test("two lost seats are two incidents, one per seat", () => {
    const two = facts({ missing: [lost("@dev/3"), lost("@dev/4")] })
    const seen = memory([
      ["@dev/3", T0 - CONFIG.graceMs],
      ["@dev/4", T0 - CONFIG.graceMs],
    ])
    expect(checkBridgeLost(two, T0, seen, CONFIG).map((a) => a.incident?.subject)).toEqual(["@dev/3", "@dev/4"])
  })

  test("an open incident stays open while the transport is gone, whoever reads their inbox", () => {
    // The 10:40 PDT silencing: the owner reading over the CLI is not a cure.
    const stillLost = facts({
      missing: [lost("@chief")],
      connected: new Set(["@cto"]),
      openIncidents: [{ subject: "@chief", recipient: "@cto" }],
    })
    expect(checkBridgeLost(stillLost, T0, memory(), CONFIG)).toEqual([])
  })

  test("the transport coming back clears the incident to its recipient, saying why", () => {
    const back = facts({ connected: new Set(["@dev/3"]), openIncidents: [{ subject: "@dev/3", recipient: "@chief" }] })
    const firstSeen = memory([["@dev/3", T0 - 10 * MIN]])
    const [clear, ...rest] = checkBridgeLost(back, T0, firstSeen, CONFIG)
    expect(rest).toEqual([])
    expect(clear).toMatchObject({ kind: "clear", recipient: "@chief", incident: { subject: "@dev/3" } })
    expect(clear?.content).toMatch(/cleared: @dev\/3's transport is live again/u)
    expect(firstSeen.firstSeen.has("@dev/3")).toBe(false)
  })

  test("a settled exit clears the incident: a gone seat is not a lost bridge, and hab owns the restart", () => {
    const exited = facts({
      exited: new Map([["@dev/3", "settled 2026-09-24T15:00:00.000Z"]]),
      openIncidents: [{ subject: "@dev/3", recipient: "@chief" }],
    })
    expect(checkBridgeLost(exited, T0, memory(), CONFIG)).toMatchObject([
      {
        kind: "clear",
        recipient: "@chief",
        content: expect.stringMatching(
          /cleared: @dev\/3 exited \(settled 2026-09-24T15:00:00.000Z\); hab owns the restart/u,
        ),
      },
    ])
  })

  test("after a daemon restart the open incident still clears when the seat recovered meanwhile", () => {
    // Nothing in memory survived the restart; the durable tracker is the only record.
    const restarted = facts({
      connected: new Set(["@dev/3"]),
      openIncidents: [{ subject: "@dev/3", recipient: "@chief" }],
    })
    expect(checkBridgeLost(restarted, T0, memory(), CONFIG)).toMatchObject([
      { kind: "clear", recipient: "@chief", incident: { subject: "@dev/3" } },
    ])
  })

  test("when every owner is itself lost, the page is an untracked notify to everyone, once", () => {
    const all = facts({ missing: [lost("@chief"), lost("@cto"), lost("@adhoc/0")] })
    const seen = memory(CONFIG.owners.map((owner) => [owner, T0 - CONFIG.graceMs] as const))
    const first = checkBridgeLost(all, T0, seen, CONFIG)
    expect(first.map((a) => [a.kind, a.recipient])).toEqual([
      ["broadcast", "*"],
      ["broadcast", "*"],
      ["broadcast", "*"],
    ])
    expect(first[0]?.content).toMatch(/no configured owner is reachable/u)
    expect(checkBridgeLost(all, T0 + MIN, seen, CONFIG)).toEqual([])
  })
})

describe("parseBridgeLostConfig", () => {
  test("arms with the configured owners and a 180 s default grace", () => {
    expect(parseBridgeLostConfig({ TRIBE_BRIDGE_LOST_OWNERS: "@chief, @cto,@adhoc/0" })).toEqual({
      armed: true,
      config: { owners: ["@chief", "@cto", "@adhoc/0"], graceMs: 180_000 },
    })
  })

  test("refuses to arm, by name, with no owners or fewer than two", () => {
    expect(parseBridgeLostConfig({})).toEqual({
      armed: false,
      reason: "TRIBE_BRIDGE_LOST_OWNERS is unset; name at least two owners",
    })
    expect(parseBridgeLostConfig({ TRIBE_BRIDGE_LOST_OWNERS: "@chief" })).toEqual({
      armed: false,
      reason: "TRIBE_BRIDGE_LOST_OWNERS names 1 owner (@chief); a lost owner needs a second to page",
    })
  })

  test("refuses a grace that is not a positive number of seconds", () => {
    expect(
      parseBridgeLostConfig({ TRIBE_BRIDGE_LOST_OWNERS: "@chief,@cto", TRIBE_BRIDGE_LOST_GRACE_SEC: "soon" }),
    ).toEqual({ armed: false, reason: 'TRIBE_BRIDGE_LOST_GRACE_SEC must be a positive number of seconds, got "soon"' })
  })

  // 25663 supplies the deadline: the shipped default grace outlasts a paced reload plus the monitor's ~30 s tick, so a
  // later change to either constant fails loud here instead of paging every reload.
  test("the default grace exceeds the shipped reload deadline plus one tick", () => {
    const tickMs = 3 * 10_000
    expect(RELOAD_DEADLINE_MS + tickMs).toBeLessThan(180_000)
    const env = { TRIBE_BRIDGE_LOST_OWNERS: "@chief,@cto" }
    expect(parseBridgeLostConfig(env, { reloadDeadlineMs: RELOAD_DEADLINE_MS, tickMs }).armed).toBe(true)
  })

  // The refusal itself, on a stub deadline.
  test("refuses a grace not greater than the reload deadline plus one tick", () => {
    const env = { TRIBE_BRIDGE_LOST_OWNERS: "@chief,@cto", TRIBE_BRIDGE_LOST_GRACE_SEC: "60" }
    expect(parseBridgeLostConfig(env, { reloadDeadlineMs: 55_000, tickMs: 10_000 })).toEqual({
      armed: false,
      reason:
        "TRIBE_BRIDGE_LOST_GRACE_SEC=60 is not greater than the reload deadline (55 s) plus one tick (10 s); a reload would page",
    })
    expect(parseBridgeLostConfig(env, { reloadDeadlineMs: 45_000, tickMs: 10_000 }).armed).toBe(true)
  })
})

describe("runBridgeLostTick on the daemon's durable ball tracker", () => {
  let dir: string
  let db: Database
  let stmts: TribeStatements

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bridge-lost-"))
    db = openDatabase(join(dir, "tribe.db"))
    stmts = createStatements(db)
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  /** The plugin API the monitor sees: the real incident rail and tracker, with transport facts supplied per tick. */
  function daemonApi(transport: () => Omit<BridgeLostFacts, "openIncidents">): TribeClientApi {
    const ctx = createTribeContext({
      db,
      stmts,
      sessionId: "sess-daemon",
      sessionRole: "member",
      initialName: "daemon",
      domains: [],
      claudeSessionId: null,
      claudeSessionName: null,
    })
    const fail = () => {
      throw new Error("not used by the bridge-lost tick")
    }
    return {
      send: (recipient, content, type, beadId, classification, incident) =>
        void sendMessage(ctx, recipient, content, type, beadId, undefined, "direct", classification ?? {}, {
          ...(incident === undefined ? {} : { incident }),
        }),
      broadcast: fail,
      claimDedup: fail,
      hasRecentMessage: fail,
      getActiveSessions: fail,
      getSessionNames: fail,
      getUnreadDms: fail,
      getSeatTransportFacts: () => {
        const facts = transport()
        return { missing: [...facts.missing], exited: new Map(facts.exited), connected: new Set(facts.connected) }
      },
      listOpenIncidents: (emitter, condition) => readOpenIncidents(stmts, emitter, condition),
    }
  }

  const openFor = (recipient: string) =>
    (stmts.selectPendingForRecipient.all({ $recipient: recipient }) as Array<{ request_id: string }>).map(
      (row) => row.request_id,
    )
  const armed = { armed: true as const, config: CONFIG }

  test("a restart in the middle of an open incident, then the seat recovers: the incident clears", () => {
    let transport: Omit<BridgeLostFacts, "openIncidents"> = facts({ missing: [lost("@dev/3")] })
    const api = daemonApi(() => transport)

    runBridgeLostTick(api, armed, memory([["@dev/3", T0 - CONFIG.graceMs]]), T0)
    runBridgeLostTick(api, armed, memory([["@dev/3", T0 - CONFIG.graceMs]]), T0 + MIN)
    expect(openFor("@chief")).toEqual(["tribe-health:@dev/3:bridge-lost"])

    // The daemon restarts: nothing in memory. The seat's bridge came back meanwhile.
    transport = facts({ connected: new Set(["@dev/3"]) })
    runBridgeLostTick(api, armed, memory(), T0 + 10 * MIN)
    expect(openFor("@chief")).toEqual([])
  })

  test("a disarmed monitor sends nothing, and another watcher's incidents are not read as bridge-lost", () => {
    const api = daemonApi(() => facts({ missing: [lost("@dev/3")] }))
    runBridgeLostTick(api, { armed: false, reason: "test" }, memory([["@dev/3", 0]]), T0)
    expect(openFor("@chief")).toEqual([])

    api.send(
      "@chief",
      "wedged",
      "notify",
      undefined,
      {},
      { emitter: "tribe-health", subject: "@dev/4", condition: "transport-wedged" },
    )
    expect(readOpenIncidents(stmts, BRIDGE_LOST_EMITTER, BRIDGE_LOST_CONDITION)).toEqual([])
  })
})
