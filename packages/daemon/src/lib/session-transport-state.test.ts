import { describe, expect, it, vi } from "vitest"
import { projectSessionTransportState, type OwnerState } from "./session-transport-state.ts"

describe("daemon-authoritative session transport state", () => {
  it("treats an authenticated registry entry as connected without a competing PID derivation", () => {
    const probeOwner = vi.fn<() => OwnerState>(() => "dead")

    expect(projectSessionTransportState({ transportConnected: true, ownerPid: 4242, probeOwner })).toEqual({
      transport_state: "connected",
      owner_state: "live",
      transport_reason: "registered-transport",
    })
    expect(probeOwner).not.toHaveBeenCalled()
  })

  it("names the live-owner/no-transport bridge wedge directly", () => {
    expect(
      projectSessionTransportState({
        transportConnected: false,
        ownerPid: 73726,
        probeOwner: () => "live",
      }),
    ).toEqual({
      transport_state: "disconnected",
      owner_state: "live",
      transport_reason: "owner-live-no-transport",
    })
  })

  it.each([
    ["dead", "owner-dead-no-transport"],
    ["unknown", "owner-unknown-no-transport"],
  ] as const)("keeps %s owner evidence separate from transport death", (ownerState, transportReason) => {
    expect(
      projectSessionTransportState({
        transportConnected: false,
        ownerPid: 8181,
        probeOwner: () => ownerState,
      }),
    ).toEqual({
      transport_state: "disconnected",
      owner_state: ownerState,
      transport_reason: transportReason,
    })
  })
})
