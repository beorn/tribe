import { describe, expect, it } from "vitest"
import { projectSessionTransportState } from "./session-transport-state.ts"

describe("daemon-authoritative session transport state", () => {
  it("treats an authenticated registry entry as connected without a competing PID derivation", () => {
    expect(projectSessionTransportState({ transportConnected: true })).toEqual({
      transport_state: "connected",
      owner_state: "live",
      transport_reason: "registered-transport",
    })
  })

  it("does not turn a disconnected row's reusable numeric PID into owner identity", () => {
    expect(projectSessionTransportState({ transportConnected: false })).toEqual({
      transport_state: "disconnected",
      owner_state: "unknown",
      transport_reason: "owner-unknown-no-transport",
    })
  })
})
