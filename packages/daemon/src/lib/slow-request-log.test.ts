/**
 * During the measured daemon wedge every RPC — cli_health, cli_pending,
 * cli_members, cli_log, MCP members, send identity resolution — failed at the
 * wire client's fixed 10s timer, and the client can only report that the call
 * did not come back. Nothing on either side recorded WHICH method was slow, and
 * the host's yama ptrace_scope blocks the stack walk that would have settled it.
 * The daemon has to name the slow method itself.
 */
import { describe, expect, it } from "vitest"

import { LONG_POLL_METHODS, SLOW_REQUEST_LOG_MS, shouldLogSlowRequest } from "./slow-request-log.ts"

describe("slow-request admission", () => {
  it("names a request that is heading for the client's 10s timeout", () => {
    expect(shouldLogSlowRequest("cli_health", 2_000)).toBe(true)
    expect(shouldLogSlowRequest("cli_members", 6_500)).toBe(true)
    expect(shouldLogSlowRequest("cli_pending", 9_999)).toBe(true)
  })

  it("stays silent for ordinary traffic", () => {
    expect(shouldLogSlowRequest("cli_health", 0)).toBe(false)
    expect(shouldLogSlowRequest("cli_members", 12)).toBe(false)
    expect(shouldLogSlowRequest("cli_pending", 1_999)).toBe(false)
  })

  it("fires below the client deadline, not at it", () => {
    // Reporting only at 10s would log nothing the client hadn't already given
    // up on — the daemon must name the method while the call is still alive.
    expect(SLOW_REQUEST_LOG_MS).toBeLessThan(10_000)
    expect(shouldLogSlowRequest("cli_log", SLOW_REQUEST_LOG_MS)).toBe(true)
  })

  it("never reports a long poll, whose slowness is its contract", () => {
    for (const method of LONG_POLL_METHODS) {
      expect(shouldLogSlowRequest(method, 300_000)).toBe(false)
    }
  })

  it("honours an explicit threshold", () => {
    expect(shouldLogSlowRequest("cli_health", 500, 250)).toBe(true)
    expect(shouldLogSlowRequest("cli_health", 200, 250)).toBe(false)
  })
})
