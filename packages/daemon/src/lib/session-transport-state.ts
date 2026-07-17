/**
 * One projection for daemon transport presence and adapter-process presence.
 *
 * Transport truth comes only from the daemon's authenticated in-memory client
 * registry. PID state is separate evidence about the process that last owned
 * the durable session row. Nothing here reads `updated_at`: last-seen age is
 * activity evidence, not liveness.
 */

export type TransportState = "connected" | "disconnected"
export type OwnerState = "live" | "dead" | "unknown"

export type SessionTransportProjection = {
  transport_state: TransportState
  owner_state: OwnerState
  transport_reason:
    | "registered-transport"
    | "owner-live-no-transport"
    | "owner-dead-no-transport"
    | "owner-unknown-no-transport"
}

export type OwnerProbe = (pid: number) => OwnerState

/** Probe OS process existence without turning an unfamiliar error into death. */
export function probeOwnerState(pid: number): OwnerState {
  if (!Number.isSafeInteger(pid) || pid <= 0) return "unknown"
  try {
    process.kill(pid, 0)
    return "live"
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ESRCH") return "dead"
    // EPERM proves the process exists even though we cannot signal it. Any
    // unfamiliar failure remains inconclusive rather than manufacturing death.
    if (code === "EPERM") return "live"
    return "unknown"
  }
}

export function projectSessionTransportState(input: {
  transportConnected: boolean
  ownerPid: number
  probeOwner?: OwnerProbe
}): SessionTransportProjection {
  // An authenticated socket is positive evidence that its adapter process is
  // alive now. Do not race that fact with a second PID derivation.
  if (input.transportConnected) {
    return {
      transport_state: "connected",
      owner_state: "live",
      transport_reason: "registered-transport",
    }
  }

  const ownerState = (input.probeOwner ?? probeOwnerState)(input.ownerPid)
  return {
    transport_state: "disconnected",
    owner_state: ownerState,
    transport_reason:
      ownerState === "live"
        ? "owner-live-no-transport"
        : ownerState === "dead"
          ? "owner-dead-no-transport"
          : "owner-unknown-no-transport",
  }
}
