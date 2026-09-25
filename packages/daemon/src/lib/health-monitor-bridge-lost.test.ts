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
 * owner whose transport is live, and clears it from the durable ball tracker
 * (never from memory) when the transport is live again or the seat exited. A
 * seat still unreachable in another state (a refused reconnect, a launch that
 * never registered) keeps its incident open, and the owner is told the state.
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
  BRIDGE_LOST_GRACE_MARGIN_MS,
  DEFAULT_BRIDGE_LOST_GRACE_MS,
  DEFAULT_BRIDGE_LOST_TICK_MS,
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
  return { missing: [], connected: new Set(), exited: new Map(), unreachable: new Map(), openIncidents: [], ...over }
}

const lost = (name: string, launchParentPid = 4242) => ({ name, launchParentPid })

/** In-memory grace clocks only; the open-incident set always comes from the durable tracker (facts). */
function memory(seen: ReadonlyArray<readonly [string, number]> = []): BridgeLostMemory {
  return { firstSeen: new Map(seen), broadcast: new Set(), namedState: new Map() }
}

describe("checkBridgeLost", () => {
  test("a seat missing-transport pages only once the grace has passed, once per incident", () => {
    const firstSeen = memory()
    const lostDev = facts({ missing: [lost("@dev/3")], connected: new Set(["@chief"]) })

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
    const held = facts({
      missing: [lost("@dev/3")],
      connected: new Set(["@chief"]),
      openIncidents: [{ subject: "@dev/3", recipient: "@chief" }],
    })
    expect(checkBridgeLost(held, T0 + 4 * MIN, firstSeen, CONFIG)).toEqual([])
  })

  test("@chief's own bridge pages the next owner, and a lost owner is skipped", () => {
    const chiefLost = facts({ missing: [lost("@chief")], connected: new Set(["@cto", "@adhoc/0"]) })
    expect(checkBridgeLost(chiefLost, T0, memory([["@chief", T0 - CONFIG.graceMs]]), CONFIG)).toMatchObject([
      { kind: "raise", recipient: "@cto", incident: { subject: "@chief" } },
    ])

    const both = facts({ missing: [lost("@chief"), lost("@cto")], connected: new Set(["@adhoc/0"]) })
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
    const two = facts({ missing: [lost("@dev/3"), lost("@dev/4")], connected: new Set(["@chief"]) })
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
    expect(first[0]?.content).toMatch(/no configured owner is connected/u)
    expect(checkBridgeLost(all, T0 + MIN, seen, CONFIG)).toEqual([])
  })

  // review-adhoc5 P3 1 (e47aafc674): an owner with no live transport cannot read the page, lost or not.
  test("an owner with no live transport is skipped: an exited @chief does not get the page while @cto is live", () => {
    const chiefGone = facts({
      missing: [lost("@dev/3")],
      exited: new Map([["@chief", "harness-exited at 2026-09-24T15:00:00.000Z"]]),
      connected: new Set(["@cto"]),
    })
    expect(checkBridgeLost(chiefGone, T0, memory([["@dev/3", T0 - CONFIG.graceMs]]), CONFIG)).toMatchObject([
      { kind: "raise", recipient: "@cto", incident: { subject: "@dev/3" } },
    ])
  })

  test("with no owner connected, the page is an untracked notify to everyone that names the owners, once", () => {
    const noOwner = facts({ missing: [lost("@dev/3")], connected: new Set(["@dev/4"]) })
    const seen = memory([["@dev/3", T0 - CONFIG.graceMs]])
    expect(checkBridgeLost(noOwner, T0, seen, CONFIG)).toMatchObject([
      {
        kind: "broadcast",
        recipient: "*",
        content: expect.stringMatching(/no configured owner is connected \(@chief, @cto, @adhoc\/0\)/u),
      },
    ])
    expect(checkBridgeLost(noOwner, T0 + MIN, seen, CONFIG)).toEqual([])
  })

  // review-adhoc5 P3 2 (e47aafc674): a seat that tried to come back and was refused is still unreachable.
  test("a seat unreachable in another state keeps its incident open and tells the owner the state, once per state", () => {
    const refused = facts({
      unreachable: new Map([["@dev/3", "foreign-identity-transport"]]),
      connected: new Set(["@chief"]),
      openIncidents: [{ subject: "@dev/3", recipient: "@chief" }],
    })
    const mem = memory()
    const [named, ...rest] = checkBridgeLost(refused, T0, mem, CONFIG)
    expect(rest).toEqual([])
    expect(named).toMatchObject({ kind: "raise", recipient: "@chief", incident: { subject: "@dev/3" } })
    expect(named?.content).toMatch(
      /@dev\/3's tribe bridge is still lost: membership reads it foreign-identity-transport/u,
    )
    expect(checkBridgeLost(refused, T0 + MIN, mem, CONFIG)).toEqual([])

    const never = facts({ ...refused, unreachable: new Map([["@dev/3", "never-registered"]]) })
    expect(checkBridgeLost(never, T0 + 2 * MIN, mem, CONFIG).map((a) => [a.kind, a.content])).toEqual([
      ["raise", expect.stringMatching(/membership reads it never-registered/u)],
    ])

    const back = facts({ connected: new Set(["@chief", "@dev/3"]), openIncidents: refused.openIncidents })
    expect(checkBridgeLost(back, T0 + 3 * MIN, mem, CONFIG)).toMatchObject([
      { kind: "clear", recipient: "@chief", content: expect.stringMatching(/transport is live again/u) },
    ])
    expect(mem.namedState.has("@dev/3")).toBe(false)
  })
})

describe("parseBridgeLostConfig", () => {
  test("arms with the configured owners and the derived default grace", () => {
    expect(parseBridgeLostConfig({ TRIBE_BRIDGE_LOST_OWNERS: "@chief, @cto,@adhoc/0" })).toEqual({
      armed: true,
      config: { owners: ["@chief", "@cto", "@adhoc/0"], graceMs: DEFAULT_BRIDGE_LOST_GRACE_MS },
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

  // 25663 r3 (@cto 5d1adade): the default grace and the reload deadline are one relation, asserted here, not two
  // literals that happen to fit: a change to either constant moves the other, and a zero margin fails loud.
  test("the default grace is the reload deadline plus one tick plus a positive margin, and it arms", () => {
    expect(DEFAULT_BRIDGE_LOST_GRACE_MS).toBe(
      RELOAD_DEADLINE_MS + DEFAULT_BRIDGE_LOST_TICK_MS + BRIDGE_LOST_GRACE_MARGIN_MS,
    )
    expect(BRIDGE_LOST_GRACE_MARGIN_MS).toBeGreaterThan(0)
    const env = { TRIBE_BRIDGE_LOST_OWNERS: "@chief,@cto" }
    const bounds = { reloadDeadlineMs: RELOAD_DEADLINE_MS, tickMs: DEFAULT_BRIDGE_LOST_TICK_MS }
    expect(parseBridgeLostConfig(env, bounds).armed).toBe(true)
    // With no margin the same relation pages on the slowest reload, and the parser refuses it.
    const noMargin = String((RELOAD_DEADLINE_MS + DEFAULT_BRIDGE_LOST_TICK_MS) / 1000)
    expect(parseBridgeLostConfig({ ...env, TRIBE_BRIDGE_LOST_GRACE_SEC: noMargin }, bounds).armed).toBe(false)
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
        void sendMessage(
          ctx,
          recipient,
          content,
          type,
          beadId,
          undefined,
          "direct",
          classification ?? {},
          incident === undefined ? {} : { incident },
        ),
      broadcast: fail,
      claimDedup: fail,
      hasRecentMessage: fail,
      getActiveSessions: fail,
      getSessionNames: fail,
      getUnreadDms: fail,
      getSeatTransportFacts: () => {
        const facts = transport()
        return {
          missing: [...facts.missing],
          exited: new Map(facts.exited),
          connected: new Set(facts.connected),
          unreachable: new Map(facts.unreachable),
        }
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
    let transport: Omit<BridgeLostFacts, "openIncidents"> = facts({
      missing: [lost("@dev/3")],
      connected: new Set(["@chief"]),
    })
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
