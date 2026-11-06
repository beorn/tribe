/**
 * @failure  the retryable inbox-wait transport classifier is duplicated or
 *           drifts between the CLI and the seat-side long wait, so a daemon
 *           promotion restart is retried by one caller and treated as a
 *           terminal source-error by the other
 * @level    l0 - pure classification, no daemon, socket, or network
 * @consumer @i/4-supervision/27397 (km-daemon respawn churn / seat reconnect)
 * @testonly none
 */
import { describe, expect, it } from "vitest"

import { inboxWaitErrorKind, isRetryableInboxWaitError, type InboxWaitErrorKind } from "../src/lib/inbox-wait-errors.ts"

function codedError(code: string): Error & { code: string } {
  const error = new Error(`connect ${code} /tmp/tribe.sock`) as Error & { code: string }
  error.code = code
  return error
}

describe("inboxWaitErrorKind", () => {
  it("classifies an absent or refusing socket as daemon-unavailable", () => {
    expect(inboxWaitErrorKind(codedError("ENOENT"))).toBe("daemon-unavailable")
    expect(inboxWaitErrorKind(codedError("ECONNREFUSED"))).toBe("daemon-unavailable")
  })

  it("classifies an established connection closing mid-read as transport-close", () => {
    expect(inboxWaitErrorKind(codedError("ECONNRESET"))).toBe("transport-close")
    expect(inboxWaitErrorKind(codedError("EPIPE"))).toBe("transport-close")
  })

  it("classifies the daemon's closed-before-response wording when no code is set", () => {
    expect(inboxWaitErrorKind(new Error("socket hang up"))).toBe("transport-close")
    expect(inboxWaitErrorKind(new Error("connection closed before response"))).toBe("transport-close")
    expect(inboxWaitErrorKind(new Error("request cli_inbox_wait timed out"))).toBe("transport-close")
    // Captured launch-identity timeout; the legacy-only match loses managed waiters (22934).
    expect(inboxWaitErrorKind(new Error("Request cli_inbox_wait_by_launch_v1 timed out after 35000ms"))).toBe(
      "transport-close",
    )
    for (const method of ["tribe.send", "cli_inbox_wait_by_launch_v2", "cli_inbox_wait_extra"]) {
      expect(inboxWaitErrorKind(new Error(`Request ${method} timed out after 35000ms`))).toBeNull()
    }
  })

  it("returns null for anything else, a real failure the caller must surface", () => {
    const kind: InboxWaitErrorKind = inboxWaitErrorKind(new Error("daemon unreachable"))
    expect(kind).toBeNull()
    expect(inboxWaitErrorKind({ code: "EACCES" })).toBeNull()
    expect(inboxWaitErrorKind("boom")).toBeNull()
  })

  it("isRetryableInboxWaitError is exactly the non-null discriminator", () => {
    expect(isRetryableInboxWaitError(codedError("ENOENT"))).toBe(true)
    expect(isRetryableInboxWaitError(codedError("ECONNRESET"))).toBe(true)
    expect(isRetryableInboxWaitError(new Error("daemon unreachable"))).toBe(false)
  })
})
