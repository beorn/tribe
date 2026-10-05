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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  DELIVERY_LEDGER_VERSION,
  DELIVERY_LEDGER_WINDOW_MS,
  deliveryLedgerDir,
  deliveryLedgerPaneKey,
  deliveryLedgerPath,
  loadDeliveryLedger,
  openDeliveryLedgerWindow,
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

const counters = (over: Partial<DeliveryLedgerState["counters"]> = {}): DeliveryLedgerState["counters"] => ({
  presentations: 0,
  newPresentations: 0,
  duplicatePresentations: 0,
  deliveries: 0,
  newDeliveries: 0,
  duplicateDeliveries: 0,
  duplicateBytes: 0,
  suppressed: 0,
  ...over,
})

describe("delivery ledger path resolution (#27459)", () => {
  it("sanitizes a pane name into a file fragment, keeping @ and -", () => {
    expect(deliveryLedgerPaneKey("@agent/test")).toBe("@agent_test")
    expect(deliveryLedgerPaneKey("@dev/luna6")).toBe("@dev_luna6")
    expect(deliveryLedgerPaneKey("   ")).toBe("unregistered")
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
})
