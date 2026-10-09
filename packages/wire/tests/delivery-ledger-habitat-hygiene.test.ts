/**
 * @failure  A test-lane process inherits the launching seat's habitat root, so an
 *           adapter test that never names its own ledger directory persists fake
 *           delivery ledgers into the LIVE habitat kpi directory, where the real
 *           4-hour per-seat delivery report reads them as that seat's history
 *           (28283; the two residue files under /hh/main.hab/kpi are dated Oct 4
 *           and Oct 5).
 * @level    l0 - this worker's own environment and the ledger path resolver
 * @consumer @i/4-supervision/27459-coordination-overhead-has-no-budget/28283-delivery-ledger-save-failure-only-warns-and-tests-write-live-ledgers
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import {
  deliveryLedgerDir,
  deliveryLedgerPath,
  TRIBE_DELIVERY_LEDGER_DIR_ENV,
  TRIBE_DELIVERY_LEDGER_ENV,
} from "../src/lib/delivery-ledger.ts"
import { HAB_SESSION_HABITAT_ROOT_ENV } from "../src/lib/hab-session-env.ts"

describe("the vendor test lane carries no ambient habitat root (28283)", () => {
  it("starts with no habitat root and no ledger override from the launching seat", () => {
    // The root setup (ag/packages/hab-core/src/test-support/vitest-env-hygiene.ts) deletes every HAB_ and TRIBE_
    // name before any test module loads. If that scrub ever loses the habitat root or a ledger override, this file
    // fails here, before an adapter test can write a fake ledger into a live habitat.
    expect(process.env[HAB_SESSION_HABITAT_ROOT_ENV] ?? "").toBe("")
    expect(process.env[TRIBE_DELIVERY_LEDGER_DIR_ENV] ?? "").toBe("")
    expect(process.env[TRIBE_DELIVERY_LEDGER_ENV] ?? "").toBe("")
  })

  it("so an unnamed ledger resolves to no file at all, never to a live habitat path", () => {
    expect(deliveryLedgerDir(process.env)).toBeNull()
    expect(deliveryLedgerPath({ pane: "@agent/test", env: process.env })).toBeNull()
  })
})
