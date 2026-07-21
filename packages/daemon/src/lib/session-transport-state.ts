/**
 * Daemon transport projection plus a conservative process-existence probe.
 *
 * Transport truth comes only from the daemon's authenticated in-memory client
 * registry. A stored numeric PID is not owner identity and never influences a
 * disconnected-row projection; the probe below is only a negative fence for
 * active name-conflict handling. Nothing here reads `updated_at`: last-seen
 * age is activity evidence, not liveness.
 */

export type TransportState = "connected" | "disconnected"
export type OwnerState = "live" | "dead" | "unknown"

export type SessionTransportProjection = {
  transport_state: TransportState
  owner_state: OwnerState
  transport_reason: "registered-transport" | "owner-unknown-no-transport"
}

/** Probe OS process existence without turning an unfamiliar error into death. */
export function probeProcessState(pid: number): OwnerState {
  if (!Number.isSafeInteger(pid) || pid <= 0) return "unknown"
  try {
    process.kill(pid, 0)
    return "live"
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ESRCH") return "dead"
    if (code === "EPERM") return "live"
    return "unknown"
  }
}

export function projectSessionTransportState(input: { transportConnected: boolean }): SessionTransportProjection {
  if (input.transportConnected) {
    return {
      transport_state: "connected",
      owner_state: "live",
      transport_reason: "registered-transport",
    }
  }

  return {
    transport_state: "disconnected",
    owner_state: "unknown",
    transport_reason: "owner-unknown-no-transport",
  }
}
