/**
 * @failure  the daemon refuses a request whose body is under 40 characters while its summary is longer (#32907), and
 *           the reconciler's clearing edge sent "The finding went away." (22): from 2026-11-26 05:35 PST every
 *           emitter's clear was refused each pass, so a cured incident stayed open (longproc-reading oom-kill).
 * @level    l1
 * @consumer every planAlertSends caller: longproc-reading, dark-work, coordination-watch, the hab controller
 * @testonly none
 */
import { describe, expect, test } from "vitest"
import { planAlertSends, type AlertLedger } from "../src/lib/incident-reconciler.ts"

const ledger: AlertLedger<"oom-kill"> = {
  reassertedAt: null,
  open: { "lr:h:oom-kill": { class: "oom-kill", to: "@dev/12", revision: "r1" } },
}

describe("a clearing edge carries a body the daemon accepts", () => {
  test("cleared: 40+ characters naming emitter, condition and subject", () => {
    const [send] = planAlertSends("lr", [], ledger, new Set())
    expect(send?.cleared).toBe(true)
    expect(send?.body.trim().length).toBeGreaterThanOrEqual(40)
    expect(send?.body).toBe("The finding went away: lr no longer measures oom-kill on h, so this ball closes.")
  })

  test("moved: 40+ characters naming the new owner", () => {
    const alert = {
      key: "lr:h:oom-kill",
      subject: "h",
      class: "oom-kill" as const,
      condition: "oom-kill",
      to: "@x",
      revision: "r2",
      summary: "s",
      body: "b",
    }
    const moved = planAlertSends("lr", [alert], ledger, new Set()).find((send) => send.cleared)
    expect(moved?.body.trim().length).toBeGreaterThanOrEqual(40)
    expect(moved?.body).toContain("now belongs to @x")
  })
})
