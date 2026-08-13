/**
 * Daemon transport projection plus a conservative process-existence probe.
 *
 * Transport truth starts at the daemon's authenticated in-memory client
 * registry, but registry presence alone is belief, not evidence: a registry
 * entry outlives the process it names whenever a socket-close handler hasn't
 * fired yet. So a registration whose transport pids are provably gone is
 * projected as disconnected at read time, and `transport_registered` keeps the
 * raw registry fact visible on its own field rather than letting it speak for
 * the transport. A row must never assert a live transport and a dead pid at
 * once.
 *
 * A stored numeric PID is still not owner identity: it never influences a
 * DISCONNECTED row's projection, because PIDs are reusable and a row with no
 * transport has nothing live to probe. Nothing here reads `updated_at`:
 * last-seen age is activity evidence, not liveness.
 */

export type TransportState = "connected" | "disconnected"
export type OwnerState = "live" | "dead" | "unknown"

export type SessionTransportProjection = {
  transport_registered: boolean
  transport_state: TransportState
  owner_state: OwnerState
  transport_reason: "registered-transport" | "registered-transport-pids-dead" | "owner-unknown-no-transport"
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

/**
 * `transportPidsAlive` is the read-time probe of the pids the registry itself
 * reports for this connection. Omitted or `true` keeps the registration's
 * word — a transport with no known pids is unproven, not dead.
 */
export function projectSessionTransportState(input: {
  transportConnected: boolean
  transportPidsAlive?: boolean
}): SessionTransportProjection {
  if (input.transportConnected) {
    if (input.transportPidsAlive === false) {
      return {
        transport_registered: true,
        transport_state: "disconnected",
        owner_state: "dead",
        transport_reason: "registered-transport-pids-dead",
      }
    }
    return {
      transport_registered: true,
      transport_state: "connected",
      owner_state: "live",
      transport_reason: "registered-transport",
    }
  }

  return {
    transport_registered: false,
    transport_state: "disconnected",
    owner_state: "unknown",
    transport_reason: "owner-unknown-no-transport",
  }
}

/** Project combined session liveness (transport + process existence + silence degradation). */
export function projectSessionLiveness(input: {
  transportConnected: boolean
  pidAlive?: boolean
  agentPidAlive?: boolean
  lastSeenSec?: number | null
  maxSilenceSec?: number
}): {
  alive: boolean
  transport_alive: boolean
  agent_alive: boolean
  pid_alive: boolean
  is_silent: boolean
} {
  const pid_alive = input.pidAlive ?? true
  // `pidAlive` is the probe of this transport's own pids, so a registered
  // transport with dead pids is not a live transport. Deriving the field here
  // makes `transport_alive: true` alongside `pid_alive: false` unrepresentable
  // rather than merely discouraged.
  const transport_alive = input.transportConnected && pid_alive
  const agent_alive = input.agentPidAlive ?? true
  const maxSilenceSec = input.maxSilenceSec ?? 14400
  const is_silent = typeof input.lastSeenSec === "number" && input.lastSeenSec > maxSilenceSec
  const alive = transport_alive && pid_alive && agent_alive && !is_silent

  return {
    alive,
    transport_alive,
    agent_alive,
    pid_alive,
    is_silent,
  }
}
