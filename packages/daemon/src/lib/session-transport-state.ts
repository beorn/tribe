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

export type SessionAnswerCapability = "observed" | "not-observed"

/** Existing activity horizon used by the member liveness projection. */
export const DEFAULT_MAX_SILENCE_SEC = 14_400

export type SessionTransportEvidence = SessionTransportProjection & {
  alive: boolean
  transport_alive: boolean
  agent_alive: boolean
  pid_alive: boolean
  is_silent: boolean
  answer_capability: SessionAnswerCapability
  answer_reason:
    | "connected-pid-live-transport"
    | "registered-transport-pids-dead"
    | "registered-owner-pid-dead"
    | "owner-unknown-no-transport"
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
  const maxSilenceSec = input.maxSilenceSec ?? DEFAULT_MAX_SILENCE_SEC
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

/**
 * One PID-aware evidence projection shared by members, tracked-send admission,
 * and pending. `answer_capability` is deliberately an observation about this
 * transport snapshot, never a claim that the persona is permanently alive or
 * dead. Silence remains visible in `alive` but does not make a connected,
 * process-live transport unable to receive a new obligation.
 */
export function projectSessionTransportEvidence(input: {
  transportConnected: boolean
  transportPids: readonly number[]
  agentPid: number | null
  lastSeenSec?: number | null
  maxSilenceSec?: number
  probe?: (pid: number) => OwnerState
}): SessionTransportEvidence {
  const probe = input.probe ?? probeProcessState
  const transportPidsAlive =
    input.transportPids.length === 0 || input.transportPids.some((pid) => probe(pid) !== "dead")
  const transport = projectSessionTransportState({
    transportConnected: input.transportConnected,
    transportPidsAlive: input.transportConnected ? transportPidsAlive : undefined,
  })
  const agentPidAlive = input.agentPid === null || probe(input.agentPid) !== "dead"
  const liveness = input.transportConnected
    ? projectSessionLiveness({
        transportConnected: true,
        pidAlive: transportPidsAlive,
        agentPidAlive,
        lastSeenSec: input.lastSeenSec,
        maxSilenceSec: input.maxSilenceSec,
      })
    : projectSessionLiveness({ transportConnected: false })
  const answerCapability = liveness.transport_alive && liveness.agent_alive
  const answerReason: SessionTransportEvidence["answer_reason"] = answerCapability
    ? "connected-pid-live-transport"
    : !input.transportConnected
      ? "owner-unknown-no-transport"
      : !transportPidsAlive
        ? "registered-transport-pids-dead"
        : "registered-owner-pid-dead"
  return {
    ...transport,
    ...liveness,
    answer_capability: answerCapability ? "observed" : "not-observed",
    answer_reason: answerReason,
  }
}
