// #27459 — the durable per-pane first-successful-handoff ledger (@cto 9a077460).
// One small JSON file per pane under habitat kpi state; bounded; a missing file
// is a fresh window while an unreadable one is a LOST window that must report a
// gap rather than an invented zero.
/**
 * @failure  A restart that loses the first-handoff identity set, or a corrupt
 *           ledger read back as a clean zero, silently under-counts duplicate
 *           deliveries in the per-seat report (#27459).
 * @level    l2
 * @consumer @cto 9a077460 adapter/Tribe delivery counter and the 4h per-seat report
 * @testonly none
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  DELIVERY_LEDGER_VERSION,
  DELIVERY_LEDGER_WINDOW_MS,
  deliveryLedgerDir,
  deliveryLedgerLegacyPaneKey,
  deliveryLedgerLegacyPath,
  deliveryLedgerPaneKey,
  deliveryLedgerPath,
  loadDeliveryLedger,
  openDeliveryLedgerWindow,
  resumeDeliveryLedger,
  saveDeliveryLedger,
  TRIBE_DELIVERY_LEDGER_DIR_ENV,
  TRIBE_DELIVERY_LEDGER_ENV,
  type DeliveryLedgerState,
} from "../src/lib/delivery-ledger.ts"

const NOW = Date.UTC(2026, 4, 30, 12, 0, 0)

function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "tribe-delivery-ledger-"))
  return join(dir, "ledger.json")
}

/** #27488 phase 0 - the cost block a costing adapter writes; fixtures are v2 ledgers. */
function costBlock(over: Partial<NonNullable<DeliveryLedgerState["counters"]["cost"]>> = {}) {
  return {
    deliveredBytes: 0,
    handoffs: 0,
    readRepeatBodies: 0,
    readRepeatBytes: 0,
    readPulls: 0,
    readPullBytes: 0,
    ...over,
  }
}

const counters = (over: Partial<DeliveryLedgerState["counters"]> = {}): DeliveryLedgerState["counters"] => ({
  presentations: 0,
  newPresentations: 0,
  duplicatePresentations: 0,
  deliveries: 0,
  newDeliveries: 0,
  duplicateDeliveries: 0,
  duplicateBytes: 0,
  suppressed: 0,
  cost: costBlock(),
  ...over,
})

describe("delivery ledger path resolution (#27459)", () => {
  it("sanitizes a pane name into a file fragment, keeping @ and -", () => {
    // #28376 — the key is INJECTIVE: an unsafe byte is percent-encoded and `%`
    // itself is encoded, so no two distinct personas can share one key/file.
    expect(deliveryLedgerPaneKey("@agent/test")).toBe("@agent%2Ftest")
    expect(deliveryLedgerPaneKey("@dev/luna6")).toBe("@dev%2Fluna6")
    expect(deliveryLedgerPaneKey("@dev.5-imber")).toBe("@dev.5-imber")
    expect(deliveryLedgerPaneKey("100%")).toBe("100%25")
    expect(deliveryLedgerPaneKey("   ")).toBe("unregistered")
    expect(deliveryLedgerPaneKey("@dev/6")).not.toBe(deliveryLedgerPaneKey("@dev_6"))
  })

  it("keeps the pre-fix SANITIZING key only to locate a legacy file (#28376)", () => {
    expect(deliveryLedgerLegacyPaneKey("@agent/test")).toBe("@agent_test")
    expect(deliveryLedgerLegacyPaneKey("@dev/luna6")).toBe("@dev_luna6")
    expect(deliveryLedgerLegacyPaneKey("   ")).toBe("unregistered")
    // The collision the v2 namespace exists to end: two personas, one legacy key.
    expect(deliveryLedgerLegacyPaneKey("@dev/6")).toBe(deliveryLedgerLegacyPaneKey("@dev_6"))
  })

  it("prefers an explicit ledger file over any directory", () => {
    const env = { [TRIBE_DELIVERY_LEDGER_ENV]: "/tmp/explicit.json", [TRIBE_DELIVERY_LEDGER_DIR_ENV]: "/tmp/dir" }
    expect(deliveryLedgerPath({ pane: "@dev/luna6", env })).toBe("/tmp/explicit.json")
  })

  it("resolves the habitat kpi directory, and refuses to invent one without a habitat", () => {
    expect(deliveryLedgerDir({ HAB_SESSION_HABITAT_ROOT: "/hh/main.hab" })).toBe("/hh/main.hab/kpi")
    // No habitat root and no override: null, so the caller counts in memory and
    // never writes outside the habitat (25231).
    expect(deliveryLedgerDir({})).toBeNull()
    expect(deliveryLedgerPath({ pane: "@dev/luna6", env: {} })).toBeNull()
  })

  it("names a new ledger in a DISJOINT v2 namespace, never equal to a legacy path (#28376)", () => {
    const env = { [TRIBE_DELIVERY_LEDGER_DIR_ENV]: "/tmp/kpi" }
    expect(deliveryLedgerPath({ pane: "@dev/6", env })).toBe("/tmp/kpi/tribe-delivery-v2-@dev%2F6.json")
    expect(deliveryLedgerPath({ pane: "@dev_6", env })).toBe("/tmp/kpi/tribe-delivery-v2-@dev_6.json")
    expect(deliveryLedgerLegacyPath({ pane: "@dev_6", env })).toBe("/tmp/kpi/tribe-delivery-@dev_6.json")
    for (const pane of ["@dev/6", "@dev_6", "@agent/test"]) {
      expect(deliveryLedgerPath({ pane, env })).not.toBe(deliveryLedgerLegacyPath({ pane, env }))
    }
    // An explicit ledger file IS the ledger: nothing is invented beside it.
    const explicit = { [TRIBE_DELIVERY_LEDGER_ENV]: "/tmp/explicit.json" }
    expect(deliveryLedgerLegacyPath({ pane: "@dev/6", env: explicit })).toBeNull()
  })
})

describe("loadDeliveryLedger (#27459)", () => {
  it("treats a missing file as a FRESH window — not a gap", () => {
    const loaded = loadDeliveryLedger(join(tmpdir(), "does-not-exist-27459.json"))
    expect(loaded.state).toBeNull()
    expect(loaded.coverage).toEqual({ restarts: 0, gap: false, gapReason: "none" })
  })

  it("reports an unreadable file as a LOST window (gap), never a clean zero", () => {
    const path = tempPath()
    writeFileSync(path, "{ not json", "utf8")
    const loaded = loadDeliveryLedger(path)
    expect(loaded.state).toBeNull()
    expect(loaded.coverage).toMatchObject({ gap: true, gapReason: "unreadable" })
    rmSync(path, { force: true })
  })

  it("reports a schema-invalid file as a lost window", () => {
    const path = tempPath()
    writeFileSync(path, JSON.stringify({ version: 99, pane: "@x", ids: "nope" }), "utf8")
    const loaded = loadDeliveryLedger(path)
    expect(loaded.state).toBeNull()
    expect(loaded.coverage).toMatchObject({ gap: true, gapReason: "schema" })
    rmSync(path, { force: true })
  })

  it("names a non-representable timestamp as a schema gap, never a crash", () => {
    // Written as raw text: JSON.parse reads the literal 1e400 as Infinity, while
    // JSON.stringify would have collapsed it to null. The report formats
    // windowStartMs as ISO, and one such row must not take the healthy rows down.
    const path = tempPath()
    writeFileSync(
      path,
      `{"version":${DELIVERY_LEDGER_VERSION},"pane":"@dev/luna6","windowStartMs":1e400,"ids":[],` +
        `"counters":${JSON.stringify(counters())},"coverage":{"restarts":0,"gap":false,"gapReason":"none"}}`,
      "utf8",
    )
    const loaded = loadDeliveryLedger(path)
    expect(loaded.state).toBeNull()
    expect(loaded.coverage).toMatchObject({ gap: true, gapReason: "schema" })
    rmSync(path, { force: true })
  })

  it("rejects a representable start whose four-hour window end overflows TimeClip", () => {
    const path = tempPath()
    writeFileSync(
      path,
      JSON.stringify({
        version: DELIVERY_LEDGER_VERSION,
        pane: "@dev/luna6",
        windowStartMs: 8_640_000_000_000_000, // the last valid Date, but +4h is not
        ids: [],
        counters: counters(),
        coverage: { restarts: 0, gap: false, gapReason: "none" },
      }),
      "utf8",
    )
    const loaded = loadDeliveryLedger(path)
    expect(loaded.state).toBeNull()
    expect(loaded.coverage).toMatchObject({ gap: true, gapReason: "schema" })
    rmSync(path, { force: true })
  })

  it("names a non-representable costSinceMs as a schema gap, never a retained Infinity (@dev/11)", () => {
    // Written as raw text: JSON.parse reads the literal 1e400 as Infinity. The report formats
    // costSinceMs as an ISO date, and a retained Infinity made formatSeatCost throw for every row.
    const path = tempPath()
    writeFileSync(
      path,
      `{"version":${DELIVERY_LEDGER_VERSION},"pane":"@dev/luna6","windowStartMs":${NOW},"updatedAtMs":${NOW},"ids":[],` +
        `"counters":${JSON.stringify(counters())},"costSinceMs":1e400,` +
        `"coverage":{"restarts":0,"gap":false,"gapReason":"none"}}`,
      "utf8",
    )
    const loaded = loadDeliveryLedger(path)
    expect(loaded.state).toBeNull()
    expect(loaded.coverage).toMatchObject({ gap: true, gapReason: "schema" })
    rmSync(path, { force: true })
  })

  it("keeps a missing or null costSinceMs a readable window, not a gap (@dev/11)", () => {
    // The v1-upgrade marker and a legacy null are legitimate "cost unmeasured" states; only a
    // non-representable NUMBER is a schema gap.
    for (const costSince of [undefined, null] as const) {
      const path = tempPath()
      const body: Record<string, unknown> = {
        version: DELIVERY_LEDGER_VERSION,
        pane: "@dev/luna6",
        windowStartMs: NOW,
        updatedAtMs: NOW,
        ids: [],
        counters: counters(),
        coverage: { restarts: 0, gap: false, gapReason: "none" },
      }
      if (costSince !== undefined) body.costSinceMs = costSince
      writeFileSync(path, JSON.stringify(body), "utf8")
      const loaded = loadDeliveryLedger(path)
      expect(loaded.state?.costSinceMs, `costSinceMs=${String(costSince)}`).toBeNull()
      expect(loaded.coverage.gap, `costSinceMs=${String(costSince)}`).toBe(false)
      rmSync(path, { force: true })
    }
  })

  it("round-trips a saved state", () => {
    const path = tempPath()
    const state = openDeliveryLedgerWindow({
      existing: null,
      coverage: { restarts: 0, gap: false, gapReason: "none" },
      pane: "@dev/luna6",
      now: NOW,
    })
    state.ids = ["row-a"]
    state.counters = counters({ deliveries: 1, newDeliveries: 1 })
    saveDeliveryLedger(path, state)
    const loaded = loadDeliveryLedger(path)
    expect(loaded.state).toMatchObject({ pane: "@dev/luna6", windowStartMs: NOW, ids: ["row-a"] })
    expect(loaded.state?.counters.newDeliveries).toBe(1)
    rmSync(path, { force: true })
  })

  // #27459 gap-7 — the open-ball summary throttle's fingerprint is persisted in
  // the same ledger, so an adapter restart resumes the throttle instead of
  // re-presenting an unchanged "You own N balls ..." line.
  it("round-trips the pending-ball summary fingerprint (#27459 gap-7)", () => {
    const path = tempPath()
    const state = openDeliveryLedgerWindow({
      existing: null,
      coverage: { restarts: 0, gap: false, gapReason: "none" },
      pane: "@dev/luna6",
      now: NOW,
    })
    state.pendingBallSummary = { previewIds: "r1,r2", total: 2, withheld: 0, sentAt: NOW }
    saveDeliveryLedger(path, state)
    const loaded = loadDeliveryLedger(path)
    expect(loaded.state?.pendingBallSummary).toEqual({ previewIds: "r1,r2", total: 2, withheld: 0, sentAt: NOW })
    rmSync(path, { force: true })
  })

  it("loads a ledger written before gap-7 as a null fingerprint — fail open, not a gap", () => {
    const path = tempPath()
    const state = openDeliveryLedgerWindow({
      existing: null,
      coverage: { restarts: 0, gap: false, gapReason: "none" },
      pane: "@dev/luna6",
      now: NOW,
    })
    const older = { ...state } as Record<string, unknown>
    delete older.pendingBallSummary
    writeFileSync(path, JSON.stringify(older), "utf8")
    const loaded = loadDeliveryLedger(path)
    expect(loaded.coverage).toEqual({ restarts: 0, gap: false, gapReason: "none" })
    expect(loaded.state?.pendingBallSummary).toBeNull()
    rmSync(path, { force: true })
  })

  it("reads a malformed fingerprint as null without losing the delivery counts", () => {
    const path = tempPath()
    const state = openDeliveryLedgerWindow({
      existing: null,
      coverage: { restarts: 0, gap: false, gapReason: "none" },
      pane: "@dev/luna6",
      now: NOW,
    })
    writeFileSync(path, JSON.stringify({ ...state, pendingBallSummary: { previewIds: 7 } }), "utf8")
    const loaded = loadDeliveryLedger(path)
    expect(loaded.coverage.gap).toBe(false)
    expect(loaded.state?.pendingBallSummary).toBeNull()
    rmSync(path, { force: true })
  })
})

describe("openDeliveryLedgerWindow (#27459)", () => {
  it("resumes an in-flight window on restart, counting the restart and keeping counters", () => {
    const existing: DeliveryLedgerState = {
      version: DELIVERY_LEDGER_VERSION,
      pane: "@dev/luna6",
      windowStartMs: NOW,
      updatedAtMs: NOW,
      ids: ["row-a"],
      counters: counters({ deliveries: 3, duplicateDeliveries: 1, duplicateBytes: 40 }),
      pendingBallSummary: null,
      coverage: { restarts: 1, gap: false, gapReason: "none" },
    }
    const resumed = openDeliveryLedgerWindow({
      existing,
      coverage: existing.coverage,
      pane: "@dev/luna6",
      now: NOW + 60_000,
    })
    expect(resumed.windowStartMs).toBe(NOW)
    expect(resumed.counters.duplicateDeliveries).toBe(1)
    expect(resumed.ids).toEqual(["row-a"])
    expect(resumed.coverage).toMatchObject({ restarts: 2, gap: false })
  })

  it("rolls a fresh window after 4h, zeroing counters but keeping the identity set", () => {
    const existing: DeliveryLedgerState = {
      version: DELIVERY_LEDGER_VERSION,
      pane: "@dev/luna6",
      windowStartMs: NOW,
      updatedAtMs: NOW,
      ids: ["row-a"],
      counters: counters({ deliveries: 9, duplicateDeliveries: 4 }),
      pendingBallSummary: null,
      coverage: { restarts: 2, gap: true, gapReason: "unreadable" },
    }
    const rolled = openDeliveryLedgerWindow({
      existing,
      coverage: existing.coverage,
      pane: "@dev/luna6",
      now: NOW + DELIVERY_LEDGER_WINDOW_MS + 1,
    })
    expect(rolled.windowStartMs).toBe(NOW + DELIVERY_LEDGER_WINDOW_MS + 1)
    expect(rolled.counters.deliveries).toBe(0)
    expect(rolled.ids).toEqual(["row-a"])
    // A contiguous roll is fully covered; the prior window's gap does not carry.
    expect(rolled.coverage).toEqual({ restarts: 0, gap: false, gapReason: "none" })
  })

  it("starts a fresh window with the load's gap, so lost state is visible", () => {
    const fresh = openDeliveryLedgerWindow({
      existing: null,
      coverage: { restarts: 0, gap: true, gapReason: "unreadable" },
      pane: "@dev/luna6",
      now: NOW,
    })
    expect(fresh.coverage).toEqual({ restarts: 0, gap: true, gapReason: "unreadable" })
    expect(fresh.counters.deliveries).toBe(0)
  })

  it("writes a bounded single file (no content, no append log)", () => {
    const path = tempPath()
    const state = openDeliveryLedgerWindow({
      existing: null,
      coverage: { restarts: 0, gap: false, gapReason: "none" },
      pane: "@dev/luna6",
      now: NOW,
    })
    saveDeliveryLedger(path, state)
    const text = readFileSync(path, "utf8")
    expect(text).not.toContain("\n") // one line, one JSON object
    rmSync(path, { force: true })
  })

  it("carries the summary fingerprint across a restart and a 4h roll (#27459 gap-7)", () => {
    const summary = { previewIds: "r1", total: 1, withheld: 0, sentAt: NOW }
    const existing: DeliveryLedgerState = {
      version: DELIVERY_LEDGER_VERSION,
      pane: "@dev/luna6",
      windowStartMs: NOW,
      updatedAtMs: NOW,
      ids: [],
      counters: counters(),
      pendingBallSummary: summary,
      coverage: { restarts: 0, gap: false, gapReason: "none" },
    }
    const resumed = openDeliveryLedgerWindow({
      existing,
      coverage: existing.coverage,
      pane: "@dev/luna6",
      now: NOW + 60_000,
    })
    expect(resumed.pendingBallSummary).toEqual(summary)
    const rolled = openDeliveryLedgerWindow({
      existing,
      coverage: existing.coverage,
      pane: "@dev/luna6",
      now: NOW + DELIVERY_LEDGER_WINDOW_MS + 1,
    })
    expect(rolled.pendingBallSummary).toEqual(summary)
  })
})

describe("delivery ledger cost (#27488 phase 0)", () => {
  it("round-trips the cost block", () => {
    const path = tempPath()
    const state: DeliveryLedgerState = {
      version: DELIVERY_LEDGER_VERSION,
      pane: "@dev/luna6",
      windowStartMs: NOW,
      updatedAtMs: NOW + 1_000,
      ids: ["row-a"],
      counters: counters({
        deliveries: 2,
        cost: costBlock({
          deliveredBytes: 500,
          handoffs: 2,
          readPulls: 1,
          readPullBytes: 200,
          readRepeatBodies: 1,
          readRepeatBytes: 50,
        }),
      }),
      pendingBallSummary: null,
      costSinceMs: null,
      coverage: { restarts: 0, gap: false, gapReason: "none" },
    }
    saveDeliveryLedger(path, state)
    const loaded = loadDeliveryLedger(path)
    expect(loaded.coverage.gap).toBe(false)
    expect(loaded.state?.counters.cost?.deliveredBytes).toBe(500)
    expect(loaded.state?.counters.cost?.handoffs).toBe(2)
    expect(loaded.state?.counters.cost?.readRepeatBodies).toBe(1)
  })

  it("resumes a pre-cost v1 window and records that cost began at the resume", () => {
    const path = tempPath()
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        pane: "@dev/luna6",
        windowStartMs: NOW,
        updatedAtMs: NOW,
        ids: ["row-a"],
        counters: {
          presentations: 4,
          newPresentations: 2,
          duplicatePresentations: 2,
          deliveries: 2,
          newDeliveries: 2,
          duplicateDeliveries: 0,
          duplicateBytes: 0,
          suppressed: 2,
        },
        pendingBallSummary: null,
        coverage: { restarts: 0, gap: false, gapReason: "none" },
      }),
      "utf8",
    )
    const loaded = loadDeliveryLedger(path)
    expect(loaded.coverage.gap).toBe(false)
    expect(loaded.state?.counters.cost).toBeUndefined()
    const opened = openDeliveryLedgerWindow({
      existing: loaded.state,
      coverage: loaded.coverage,
      pane: "@dev/luna6",
      now: NOW + 60_000,
    })
    expect(opened.windowStartMs).toBe(NOW)
    expect(opened.counters.deliveries).toBe(2)
    expect(opened.counters.cost).toBeUndefined()
    expect(opened.costSinceMs).toBe(NOW + 60_000)
  })

  it("names a v2 ledger whose cost block is malformed a schema gap, never a partial total", () => {
    const path = tempPath()
    writeFileSync(
      path,
      JSON.stringify({
        version: DELIVERY_LEDGER_VERSION,
        pane: "@dev/luna6",
        windowStartMs: NOW,
        updatedAtMs: NOW,
        ids: [],
        counters: { ...counters(), cost: { deliveredBytes: "lots" } },
        pendingBallSummary: null,
        coverage: { restarts: 0, gap: false, gapReason: "none" },
      }),
      "utf8",
    )
    const loaded = loadDeliveryLedger(path)
    expect(loaded.state).toBeNull()
    expect(loaded.coverage.gapReason).toBe("schema")
  })
})

// #28376 — @cto's option B: an injective key in a DISJOINT `v2` namespace, plus a
// one-time, read-only adoption of a LIVE legacy window this pane owns. These are
// the ruling's acceptance rows, driven through the real helpers the adapter uses.
describe("colliding personas and the legacy window adoption (#28376)", () => {
  const ORIGINAL = "@dev/6"
  const UNDERSCORE = "@dev_6"

  function ledgerDir(): string {
    return mkdtempSync(join(tmpdir(), "tribe-delivery-28376-"))
  }

  /** A persisted ledger file body, as `saveDeliveryLedger` would write it. */
  function fixture(pane: string, windowStartMs: number, ids: string[]): string {
    return JSON.stringify({
      version: DELIVERY_LEDGER_VERSION,
      pane,
      windowStartMs,
      updatedAtMs: windowStartMs,
      ids,
      counters: counters(),
      pendingBallSummary: null,
      coverage: { restarts: 0, gap: false, gapReason: "none" },
    })
  }

  function resumeIn(dir: string, pane: string, now: number) {
    const r = resumeDeliveryLedger({ pane, env: { [TRIBE_DELIVERY_LEDGER_DIR_ENV]: dir }, now })
    if (r === null) throw new Error(`no ledger path for ${pane}`)
    return r
  }

  function pathIn(dir: string, pane: string): string {
    const p = deliveryLedgerPath({ pane, env: { [TRIBE_DELIVERY_LEDGER_DIR_ENV]: dir } })
    if (p === null) throw new Error(`no ledger path for ${pane}`)
    return p
  }

  /** The adapter's own persist step, mirrored: resume, open, save under `path`. */
  function persist(dir: string, pane: string, ids: string[], deliveries: number, now: number): string {
    const r = resumeIn(dir, pane, now)
    const opened = openDeliveryLedgerWindow({ existing: r.load.state, coverage: r.load.coverage, pane, now })
    saveDeliveryLedger(r.path, {
      ...opened,
      updatedAtMs: now,
      ids,
      counters: counters({ deliveries, newDeliveries: deliveries }),
    })
    return r.path
  }

  it("alternates both personas' persists and restarts: each keeps its own ids, counters and window", () => {
    const dir = ledgerDir()
    // A (@dev/6) and B (@dev_6) write in turn; A then B again.
    const pathA = persist(dir, ORIGINAL, ["only-a"], 1, NOW)
    const pathB = persist(dir, UNDERSCORE, ["only-b"], 5, NOW + 1)
    expect(pathA).not.toBe(pathB)
    persist(dir, ORIGINAL, ["only-a", "only-a2"], 2, NOW + 2)
    persist(dir, UNDERSCORE, ["only-b", "only-b2"], 6, NOW + 3)

    // A restart for each: its OWN window, ids and counters, not the other's.
    const a = resumeIn(dir, ORIGINAL, NOW + 4)
    const b = resumeIn(dir, UNDERSCORE, NOW + 4)
    expect(a.adoptedFrom).toBeNull()
    expect(b.adoptedFrom).toBeNull()
    expect(a.foreign).toBeNull()
    expect(b.foreign).toBeNull()
    expect(a.load.state?.pane).toBe(ORIGINAL)
    expect(b.load.state?.pane).toBe(UNDERSCORE)
    expect([...(a.load.state?.ids ?? [])].sort()).toEqual(["only-a", "only-a2"])
    expect([...(b.load.state?.ids ?? [])].sort()).toEqual(["only-b", "only-b2"])
    expect(a.load.state?.counters.deliveries).toBe(2)
    expect(b.load.state?.counters.deliveries).toBe(6)
    // Each kept its own window start: no roll, and no adopting the other's.
    expect(a.load.state?.windowStartMs).toBe(NOW)
    expect(b.load.state?.windowStartMs).toBe(NOW + 1)
    expect(a.load.coverage.gap).toBe(false)
    expect(b.load.coverage.gap).toBe(false)
  })

  it("adopts a LIVE legacy window this pane owns, once, and re-persists it under the v2 path", () => {
    const dir = ledgerDir()
    const legacyPath = deliveryLedgerLegacyPath({ pane: UNDERSCORE, env: { [TRIBE_DELIVERY_LEDGER_DIR_ENV]: dir } })
    expect(legacyPath).not.toBeNull()
    writeFileSync(legacyPath!, fixture(UNDERSCORE, NOW - 60_000, ["legacy-row"]), "utf8")
    const legacyBefore = readFileSync(legacyPath!, "utf8")

    const first = resumeIn(dir, UNDERSCORE, NOW)
    expect(first.adoptedFrom).toBe(legacyPath)
    expect(first.foreign).toBeNull()
    expect(first.expiredLegacy).toBeNull()
    expect(first.load.state?.ids).toEqual(["legacy-row"])
    expect(first.path).toBe(pathIn(dir, UNDERSCORE))
    expect(first.path).not.toBe(legacyPath)

    // The adoption is a READ: the persist goes to the v2 path and the legacy file
    // is left exactly as it was.
    persist(dir, UNDERSCORE, ["legacy-row"], 1, NOW)
    expect(readFileSync(legacyPath!, "utf8")).toBe(legacyBefore)
    expect(existsSync(pathIn(dir, UNDERSCORE))).toBe(true)

    // The next resume reads its OWN v2 file: the adoption read has retired itself.
    const second = resumeIn(dir, UNDERSCORE, NOW + 1)
    expect(second.adoptedFrom).toBeNull()
    expect(second.load.state?.ids).toEqual(["legacy-row"])
  })

  it("never adopts a legacy window recorded for ANOTHER persona; opens the named gap", () => {
    const dir = ledgerDir()
    const legacyPath = deliveryLedgerLegacyPath({ pane: UNDERSCORE, env: { [TRIBE_DELIVERY_LEDGER_DIR_ENV]: dir } })
    writeFileSync(legacyPath!, fixture(ORIGINAL, NOW - 60_000, ["only-a"]), "utf8")
    const legacyBefore = readFileSync(legacyPath!, "utf8")

    const r = resumeIn(dir, UNDERSCORE, NOW)
    expect(r.adoptedFrom).toBeNull()
    expect(r.foreign).toEqual({ path: legacyPath, owner: ORIGINAL })
    expect(r.expiredLegacy).toBeNull()
    expect(r.load.state).toBeNull()
    expect(r.load.coverage).toMatchObject({ gap: true, gapReason: "schema" })

    // Persisting this pane must never write or delete the other persona's file.
    persist(dir, UNDERSCORE, ["only-b"], 1, NOW)
    expect(readFileSync(legacyPath!, "utf8")).toBe(legacyBefore)
  })

  it("does not adopt an EXPIRED legacy window this pane owns", () => {
    const dir = ledgerDir()
    const legacyPath = deliveryLedgerLegacyPath({ pane: UNDERSCORE, env: { [TRIBE_DELIVERY_LEDGER_DIR_ENV]: dir } })
    writeFileSync(legacyPath!, fixture(UNDERSCORE, NOW - DELIVERY_LEDGER_WINDOW_MS - 1, ["stale-row"]), "utf8")
    const legacyBefore = readFileSync(legacyPath!, "utf8")

    const r = resumeIn(dir, UNDERSCORE, NOW)
    expect(r.adoptedFrom).toBeNull()
    expect(r.expiredLegacy).toBe(legacyPath)
    expect(r.foreign).toBeNull()
    expect(r.load.state).toBeNull()
    expect(r.load.coverage.gap).toBe(true)

    persist(dir, UNDERSCORE, ["fresh"], 1, NOW)
    expect(readFileSync(legacyPath!, "utf8")).toBe(legacyBefore)
  })

  it("honours an explicit ledger file: no v2 namespace and no legacy adoption", () => {
    const dir = ledgerDir()
    const explicit = join(dir, "explicit.json")
    const env = { [TRIBE_DELIVERY_LEDGER_ENV]: explicit }
    expect(deliveryLedgerPath({ pane: ORIGINAL, env })).toBe(explicit)
    expect(deliveryLedgerLegacyPath({ pane: ORIGINAL, env })).toBeNull()
    // A live window at the explicit path is resumed directly, never "adopted".
    writeFileSync(explicit, fixture(ORIGINAL, NOW - 60_000, ["row"]), "utf8")
    const r = resumeDeliveryLedger({ pane: ORIGINAL, env, now: NOW })
    expect(r?.adoptedFrom).toBeNull()
    expect(r?.load.state?.ids).toEqual(["row"])
  })
})
