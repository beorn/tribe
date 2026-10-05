// #27459 — the 4-hour per-seat delivery report over the per-pane ledgers (@cto 9a077460,
// @chief af807bc0 item 2). The report reads the durable first-successful-handoff ledger and
// turns it into one row per seat: total/new/duplicate deliveries, duplicate bytes (handoffs
// only), suppressed, and the >20% / >=100 alert on the duplicateDelivery unit alone.
/**
 * @failure  A briefing reads a clean duplicate rate from a window whose ledger was lost, or
 *           fires the alert on a unit other than duplicateDelivery, silently under-counting
 *           the coordination overhead #27459 exists to cap.
 * @level    l2
 * @consumer @chief 4h briefing guard; @cto 9a077460 adapter/Tribe delivery counter
 * @testonly none
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  DELIVERY_DUPLICATE_ALERT_MIN_DELIVERIES,
  DELIVERY_DUPLICATE_ALERT_RATE,
  buildFleetDeliveryReport,
  buildSeatDeliveryReport,
  formatFleetDeliveryReport,
  readDeliveryLedgers,
} from "../src/lib/delivery-report.ts"
import { DELIVERY_LEDGER_VERSION, type DeliveryLedgerState } from "../src/lib/delivery-ledger.ts"

const NOW = Date.UTC(2026, 4, 30, 12, 0, 0)

function counters(over: Partial<DeliveryLedgerState["counters"]> = {}): DeliveryLedgerState["counters"] {
  return {
    presentations: 0,
    newPresentations: 0,
    duplicatePresentations: 0,
    deliveries: 0,
    newDeliveries: 0,
    duplicateDeliveries: 0,
    duplicateBytes: 0,
    suppressed: 0,
    ...over,
  }
}

function ledger(over: Partial<DeliveryLedgerState> = {}): DeliveryLedgerState {
  return {
    version: DELIVERY_LEDGER_VERSION,
    pane: "@dev/luna6",
    windowStartMs: NOW - 60_000,
    updatedAtMs: NOW,
    ids: [],
    counters: counters(),
    coverage: { restarts: 0, gap: false, gapReason: "none" },
    ...over,
  }
}

describe("delivery report alert rule (#27459)", () => {
  it("alerts ONLY on duplicateDelivery, strictly above 20% and at >=100 deliveries", () => {
    const at20 = buildSeatDeliveryReport(
      ledger({ counters: counters({ deliveries: 100, newDeliveries: 80, duplicateDeliveries: 20 }) }),
      NOW,
    )
    expect(at20.duplicateRate).toBeCloseTo(0.2)
    expect(at20.alert).toBe(false)

    const above = buildSeatDeliveryReport(
      ledger({ counters: counters({ deliveries: 100, newDeliveries: 78, duplicateDeliveries: 22 }) }),
      NOW,
    )
    expect(above.alert).toBe(true)

    const belowMin = buildSeatDeliveryReport(
      ledger({ counters: counters({ deliveries: 99, newDeliveries: 49, duplicateDeliveries: 50 }) }),
      NOW,
    )
    expect(belowMin.alert).toBe(false)

    expect(DELIVERY_DUPLICATE_ALERT_RATE).toBe(0.2)
    expect(DELIVERY_DUPLICATE_ALERT_MIN_DELIVERIES).toBe(100)
  })

  it("never fires on presentations, and reports a null rate when there were no deliveries", () => {
    const noisy = buildSeatDeliveryReport(
      ledger({ counters: counters({ presentations: 9000, duplicatePresentations: 8000, deliveries: 0 }) }),
      NOW,
    )
    expect(noisy.duplicateRate).toBeNull()
    expect(noisy.alert).toBe(false)
    expect(noisy.duplicatePresentations).toBe(8000)
  })

  it("counts bytes from handoffs only and reports suppressed separately", () => {
    const row = buildSeatDeliveryReport(
      ledger({
        counters: counters({
          deliveries: 120,
          newDeliveries: 100,
          duplicateDeliveries: 20,
          duplicateBytes: 4096,
          suppressed: 7,
        }),
      }),
      NOW,
    )
    expect(row.duplicateBytes).toBe(4096)
    expect(row.suppressed).toBe(7)
  })

  it("never alerts a coverage-gap row: an incomplete denominator cannot prove the rule", () => {
    const gapCounters = counters({ deliveries: 200, newDeliveries: 150, duplicateDeliveries: 50 })
    const gappy = buildSeatDeliveryReport(
      ledger({ counters: gapCounters, coverage: { restarts: 1, gap: true, gapReason: "unreadable" } }),
      NOW,
    )
    expect(gappy.duplicateRate).toBeCloseTo(0.25)
    expect(gappy.deliveries).toBe(200) // observed counters stay visible
    expect(gappy.alert).toBe(false)
    expect(gappy.alertInconclusive).toBe(true)

    const control = buildSeatDeliveryReport(ledger({ counters: gapCounters }), NOW)
    expect(control.alert).toBe(true)
    expect(control.alertInconclusive).toBe(false)

    const fleet = buildFleetDeliveryReport({
      states: [ledger({ counters: gapCounters, coverage: { restarts: 1, gap: true, gapReason: "unreadable" } })],
      now: NOW,
      source: "/tmp/kpi",
    })
    expect(fleet.alerts).toEqual([])
  })
})

describe("delivery report coverage (#27459)", () => {
  it("marks a gap window incomplete and keeps the gap visible, never a clean total", () => {
    const gappy = buildSeatDeliveryReport(
      ledger({ coverage: { restarts: 1, gap: true, gapReason: "unreadable" } }),
      NOW,
    )
    expect(gappy.complete).toBe(false)
    expect(gappy.coverage.gapReason).toBe("unreadable")
    const fleet = buildFleetDeliveryReport({
      states: [ledger({ coverage: { restarts: 1, gap: true, gapReason: "unreadable" } })],
      now: NOW,
      source: "/tmp/kpi",
    })
    expect(fleet.seats[0]?.complete).toBe(false)
  })

  it("reads only tribe-delivery-*.json, and surfaces an unreadable one as a gap (not skipped)", () => {
    const dir = mkdtempSync(join(tmpdir(), "tribe-delivery-report-"))
    try {
      writeFileSync(join(dir, "tribe-delivery-@dev_luna6.json"), JSON.stringify(ledger()), "utf8")
      writeFileSync(join(dir, "tribe-delivery-@chief.json"), "{ not json", "utf8")
      writeFileSync(join(dir, "unrelated.json"), "{}", "utf8")
      const read = readDeliveryLedgers(dir)
      expect(read.states.map((s) => s.pane)).toEqual(["@dev/luna6"])
      expect(read.gaps).toHaveLength(1)
      expect(read.gaps[0]?.file).toBe("tribe-delivery-@chief.json")
      expect(read.gaps[0]?.gapReason).toBe("unreadable")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("says where it looked when no ledger exists, rather than printing a bare zero", () => {
    const missing = join(tmpdir(), "no-such-ledger-dir-27459")
    const read = readDeliveryLedgers(missing)
    expect(read.states).toHaveLength(0)
    expect(read.gaps).toHaveLength(0)
    expect(read.dirExists).toBe(false)
  })

  it("names an inaccessible location as a gap instead of reading it as no ledgers", () => {
    const dir = mkdtempSync(join(tmpdir(), "tribe-delivery-report-err-"))
    try {
      const notADir = join(dir, "not-a-dir")
      writeFileSync(notADir, "", "utf8")
      const read = readDeliveryLedgers(join(notADir, "kpi")) // ENOTDIR, never ENOENT
      expect(read.dirExists).toBe(true)
      expect(read.states).toHaveLength(0)
      expect(read.gaps).toHaveLength(1)
      expect(read.gaps[0]?.gapReason).toBe("unreadable")
      const text = formatFleetDeliveryReport(
        buildFleetDeliveryReport({ states: [], gaps: read.gaps, now: NOW, source: join(notADir, "kpi") }),
      )
      expect(text).toContain("no readable ledgers")
      expect(text).not.toContain("no ledgers found")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("delivery report output (#27459)", () => {
  it("leaves the page-edge half for the report owner (@chief/hab) and lists alerting panes", () => {
    const fleet = buildFleetDeliveryReport({
      states: [
        ledger({
          pane: "@chief",
          counters: counters({ deliveries: 200, newDeliveries: 120, duplicateDeliveries: 80, duplicateBytes: 10_000 }),
        }),
        ledger({ pane: "@dev/luna6", counters: counters({ deliveries: 50, newDeliveries: 50 }) }),
      ],
      now: NOW,
      source: "/hh/main.hab/kpi",
    })
    expect(fleet.seats.every((s) => s.pageEdges === null)).toBe(true)
    expect(fleet.alerts).toEqual(["@chief"])
    const text = formatFleetDeliveryReport(fleet)
    expect(text).toContain("@chief")
    expect(text).toContain("%")
    expect(text).toContain("/hh/main.hab/kpi")
  })

  it("formats an empty fleet with the source and honest 'no ledgers' wording", () => {
    const fleet = buildFleetDeliveryReport({ states: [], now: NOW, source: "/tmp/kpi" })
    const text = formatFleetDeliveryReport(fleet)
    expect(text.toLowerCase()).toContain("no ledgers")
    expect(text).toContain("/tmp/kpi")
  })

  it("shows each pane own window start/end so a briefing cannot imply aligned windows", () => {
    const early = ledger({ pane: "@a", windowStartMs: NOW - 3 * 3_600_000, updatedAtMs: NOW })
    const late = ledger({ pane: "@b", windowStartMs: NOW - 60_000, updatedAtMs: NOW })
    const text = formatFleetDeliveryReport(
      buildFleetDeliveryReport({ states: [early, late], now: NOW, source: "/tmp/kpi" }),
    )
    expect(text).toContain(new Date(early.windowStartMs).toISOString())
    expect(text).toContain(new Date(early.windowStartMs + 4 * 3_600_000).toISOString())
    expect(text).toContain(new Date(late.windowStartMs).toISOString())
  })

  it("renders a gap row rate as observed but inconclusive, and never as an alert", () => {
    const gappy = ledger({
      counters: counters({ deliveries: 200, newDeliveries: 150, duplicateDeliveries: 50 }),
      coverage: { restarts: 1, gap: true, gapReason: "unreadable" },
    })
    const text = formatFleetDeliveryReport(buildFleetDeliveryReport({ states: [gappy], now: NOW, source: "/tmp/kpi" }))
    expect(text).toContain("25.0% (inconclusive)")
    expect(text).toContain("GAP:unreadable")
    expect(text).not.toContain("ALERT")
  })
})
