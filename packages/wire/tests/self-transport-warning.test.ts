/**
 * @failure A seat whose tribe transport is down reads an empty inbox with no line saying so; silence and empty have
 *          the same shape, so a deaf seat looks healthy on every instrument (G9 P0 row 7, bead
 *          @i/5-agent-loop/seats-cannot-read-their-inbox).
 * @level l1
 * @consumer `tribe inbox-status` and `tribe send`, which print this one line from the launch-scoped read
 * @testonly none
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { warnIfSelfTransportDown } from "../src/cli/self-transport-warning.ts"

afterEach(() => {
  vi.restoreAllMocks()
})

describe("warnIfSelfTransportDown", () => {
  it("names the down transport, the seat and the reason on stderr", () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {})
    warnIfSelfTransportDown("inbox-status", {
      session: "@dev/9",
      launch_id: "launch-9@3",
      transport_state: "disconnected",
      transport_reason: "owner-unknown-no-transport",
    })
    expect(stderr).toHaveBeenCalledTimes(1)
    const line = String(stderr.mock.calls[0]?.[0])
    expect(line).toContain("tribe inbox-status: WARNING")
    expect(line).toContain("transport is disconnected")
    expect(line).toContain("session @dev/9")
    expect(line).toContain("launch launch-9@3")
    expect(line).toContain("owner-unknown-no-transport")
    expect(line).toContain("Nothing is pushed to it")
  })

  it("is silent when the read carries no transport state, so a healthy seat gets no warning", () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {})
    warnIfSelfTransportDown("inbox-status", { session: "@dev/9", launch_id: "launch-9@3" })
    expect(stderr).not.toHaveBeenCalled()
  })
})
