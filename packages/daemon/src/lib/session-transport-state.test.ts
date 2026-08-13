import { describe, expect, it } from "vitest"
import { projectSessionLiveness, projectSessionTransportState } from "./session-transport-state.ts"

describe("daemon-authoritative session transport state", () => {
  it("treats an authenticated registry entry with no contrary pid evidence as connected", () => {
    expect(projectSessionTransportState({ transportConnected: true })).toEqual({
      transport_registered: true,
      transport_state: "connected",
      owner_state: "live",
      transport_reason: "registered-transport",
    })
  })

  it("does not turn a disconnected row's reusable numeric PID into owner identity", () => {
    expect(projectSessionTransportState({ transportConnected: false })).toEqual({
      transport_registered: false,
      transport_state: "disconnected",
      owner_state: "unknown",
      transport_reason: "owner-unknown-no-transport",
    })
  })

  it("projects a registered transport whose own pids are dead as disconnected", () => {
    // The registration is real and stays visible as `transport_registered`,
    // but registry presence is belief, not evidence: a socket-close handler
    // that hasn't fired yet leaves an entry behind. Six live sessions read
    // `connected` with dead pids on 2026-08-13 and nearly mis-planned a
    // fleet-wide recovery.
    expect(projectSessionTransportState({ transportConnected: true, transportPidsAlive: false })).toEqual({
      transport_registered: true,
      transport_state: "disconnected",
      owner_state: "dead",
      transport_reason: "registered-transport-pids-dead",
    })
  })

  it("keeps a transport with no known pids connected — absence of pids is not death", () => {
    expect(projectSessionTransportState({ transportConnected: true, transportPidsAlive: true })).toEqual({
      transport_registered: true,
      transport_state: "connected",
      owner_state: "live",
      transport_reason: "registered-transport",
    })
  })

  it("never reports a live transport alongside a dead pid", () => {
    expect(projectSessionLiveness({ transportConnected: true, pidAlive: false })).toEqual({
      alive: false,
      transport_alive: false,
      agent_alive: true,
      pid_alive: false,
      is_silent: false,
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
