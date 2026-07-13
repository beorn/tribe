// 20703 — deriveInboxWaitCallTimeoutMs.
//
// The socket deadline for an inbox-wait long-poll must exceed the wait it is
// polling, or the wire client's per-call timeout fires before the daemon can
// answer. This derives the per-call socket timeout from the requested wait,
// mirroring the CLI's `Math.max(10_000, timeout + 5_000)` (cli/read.ts) so CLI
// and MCP long-polls share ONE derivation instead of the parallel one that let
// the MCP path stay broken.

import { describe, expect, it } from "vitest"
import {
  deriveInboxWaitCallTimeoutMs,
  INBOX_WAIT_CALL_TIMEOUT_FLOOR_MS,
  INBOX_WAIT_CALL_TIMEOUT_MARGIN_MS,
  MAX_INBOX_WAIT_TIMEOUT_MS,
} from "../src/lib/inbox-wait-options.ts"

describe("deriveInboxWaitCallTimeoutMs (20703)", () => {
  it("uses the canonical CLI constants (10s floor, 5s margin, 30min cap)", () => {
    expect(INBOX_WAIT_CALL_TIMEOUT_FLOOR_MS).toBe(10_000)
    expect(INBOX_WAIT_CALL_TIMEOUT_MARGIN_MS).toBe(5_000)
    expect(MAX_INBOX_WAIT_TIMEOUT_MS).toBe(30 * 60 * 1000)
  })

  it("floors an unspecified or zero wait at the 10s socket floor", () => {
    expect(deriveInboxWaitCallTimeoutMs(undefined)).toBe(INBOX_WAIT_CALL_TIMEOUT_FLOOR_MS)
    expect(deriveInboxWaitCallTimeoutMs(0)).toBe(INBOX_WAIT_CALL_TIMEOUT_FLOOR_MS)
  })

  it("treats a non-finite or negative wait as unspecified (floored)", () => {
    expect(deriveInboxWaitCallTimeoutMs(Number.NaN)).toBe(INBOX_WAIT_CALL_TIMEOUT_FLOOR_MS)
    expect(deriveInboxWaitCallTimeoutMs(Number.POSITIVE_INFINITY)).toBe(INBOX_WAIT_CALL_TIMEOUT_FLOOR_MS)
    expect(deriveInboxWaitCallTimeoutMs(-5)).toBe(INBOX_WAIT_CALL_TIMEOUT_FLOOR_MS)
  })

  it("adds a 5s margin to a normal wait so the daemon answers before the socket deadline", () => {
    expect(deriveInboxWaitCallTimeoutMs(12_000)).toBe(17_000)
    expect(deriveInboxWaitCallTimeoutMs(30_000)).toBe(35_000)
  })

  it("caps a giant requested wait at 30 minutes before adding the margin", () => {
    expect(deriveInboxWaitCallTimeoutMs(24 * 60 * 60 * 1000)).toBe(
      MAX_INBOX_WAIT_TIMEOUT_MS + INBOX_WAIT_CALL_TIMEOUT_MARGIN_MS,
    )
  })
})
