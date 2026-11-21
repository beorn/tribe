/**
 * #37430 (@cto 7d6af1c0) - the failed hosted wake must have a READER, not just
 * a durable record. `tribe health` is that reader: this test pins what it
 * names, and pins that the two "nothing to show" states are distinguished from
 * a clean "none failed" instead of collapsing into silence.
 *
 * @failure  A recorded failed hosted wake stays silent: `tribe health` shows nothing, or reports a clean
 *           "none failed" when there is no kpi root or no ledger directory at all.
 * @level    l2
 * @consumer #37430 / tribe health delivery section
 * @testonly none
 */
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { formatDeliveryWakeHealth } from "../src/cli/read.ts"
import { openDeliveryLedgerWindow, recordDeliveryWakeFailure, saveDeliveryLedger } from "../src/lib/delivery-ledger.ts"

const NOW = Date.parse("2026-11-21T12:30:00.000Z")

function emptyEnv(dir?: string): NodeJS.ProcessEnv {
  return dir === undefined ? {} : { TRIBE_DELIVERY_LEDGER_DIR: dir }
}

function writeLedger(
  dir: string,
  pane: string,
  failures: Array<{ rowId: string; cause: string }>,
  file = "tribe-delivery-v2-ledger.json",
): void {
  let state = openDeliveryLedgerWindow({
    existing: null,
    coverage: { restarts: 0, gap: false, gapReason: "none" },
    pane,
    now: NOW - 60_000,
  })
  for (const failure of failures) {
    state = recordDeliveryWakeFailure(state, { ...failure, atMs: NOW - 1_000 })
  }
  saveDeliveryLedger(join(dir, file), state)
}

describe("tribe health names failed hosted wakes (#37430)", () => {
  it("names the seat, the count, and the newest row id, cause and time", () => {
    const dir = mkdtempSync(join(tmpdir(), "tribe-health-wake-"))
    writeLedger(dir, "@dev/luna6", [
      { rowId: "3898c622-1111-2222-3333-444455556666", cause: "exit 3, signal null, timeout 30000ms" },
    ])

    const lines = formatDeliveryWakeHealth(emptyEnv(dir), NOW).join("\n")

    expect(lines).toContain("@dev/luna6")
    expect(lines).toContain("1 failed hosted wake(s)")
    expect(lines).toContain("3898c622-1111-2222-3333-444455556666")
    expect(lines).toContain("exit 3")
    expect(lines).toContain("2026-11-21T12:29:59.000Z")
  })

  it("counts every failure but names the newest, and skips seats with none", () => {
    const dir = mkdtempSync(join(tmpdir(), "tribe-health-wake-"))
    writeLedger(
      dir,
      "@dev/loud",
      [
        { rowId: "older-row", cause: "first" },
        { rowId: "newest-row", cause: "second" },
      ],
      "tribe-delivery-v2-loud.json",
    )
    writeLedger(dir, "@dev/quiet", [], "tribe-delivery-v2-quiet.json")

    const lines = formatDeliveryWakeHealth(emptyEnv(dir), NOW).join("\n")
    expect(lines).toContain("@dev/loud")
    expect(lines).toContain("2 failed hosted wake(s)")
    expect(lines).toContain("newest-row")
    expect(lines).not.toContain("older-row")
    expect(lines).not.toContain("@dev/quiet")
  })

  it("is silent when no seat recorded a failure", () => {
    const dir = mkdtempSync(join(tmpdir(), "tribe-health-wake-"))
    writeLedger(dir, "@dev/quiet", [])
    expect(formatDeliveryWakeHealth(emptyEnv(dir), NOW)).toEqual([])
  })

  it("says the failure cannot be durable when there is no kpi root", () => {
    const lines = formatDeliveryWakeHealth(emptyEnv(), NOW).join("\n")
    expect(lines).toContain("not durable")
    expect(lines).toContain("25231")
  })

  it("names the missing ledger directory instead of reporting a clean none", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "tribe-health-wake-")), "absent")
    const lines = formatDeliveryWakeHealth(emptyEnv(dir), NOW).join("\n")
    expect(lines).toContain("no ledger directory at")
    expect(lines).toContain(dir)
  })
})
