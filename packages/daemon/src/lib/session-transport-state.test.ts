import { describe, expect, it } from "vitest"
import { projectSessionLiveness, projectSessionTransportState } from "./session-transport-state.ts"

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

  it("reports alive=false when agent process is dead even if MCP transport is connected (22317)", () => {
    expect(
      projectSessionLiveness({
        transportConnected: true,
        agentPidAlive: false,
      }),
    ).toEqual({
      alive: false,
      transport_alive: true,
      agent_alive: false,
      pid_alive: true,
      is_silent: false,
    })
  })

  it("reports alive=false when seat is silent beyond threshold (22317)", () => {
    expect(
      projectSessionLiveness({
        transportConnected: true,
        agentPidAlive: true,
        lastSeenSec: 15234, // ~4h14m
      }),
    ).toEqual({
      alive: false,
      transport_alive: true,
      agent_alive: true,
      pid_alive: true,
      is_silent: true,
    })
  })
})
