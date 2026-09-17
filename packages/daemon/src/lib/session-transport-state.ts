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
  transport_reason:
    | "registered-transport"
    | "registered-transport-pids-dead"
    | "owner-unknown-no-transport"
    | "transport-carries-another-seats-identity"
}

/**
 * A transport the daemon refused at register because it presented this
 * session's mailbox authority under another provider launch (24767): a
 * connector started with another seat's name and launch id. The registry keeps
 * the latest one per session until a real transport connects.
 */
export type ForeignIdentityTransport = {
  readonly name: string
  readonly launch_id: string
  readonly pid: number
  readonly refused_at: string
}

export type SessionAnswerCapability = "observed" | "not-observed"

export type SessionAnswerReason =
  | "connected-pid-live-transport"
  | "connected-no-consumer"
  | "mailbox-read-unavailable"
  | "registered-transport-pids-dead"
  | "registered-owner-pid-dead"
  | "owner-unknown-no-transport"

/**
 * What is consuming a session's mailbox right now (24664). An open set: a new
 * consumer class lands as one more member here and one more line in
 * `observeMailboxConsumers`, never as a second definition of `observed`.
 */
export type MailboxConsumer = "push-client" | "inbox-wait"

/** Existing activity horizon used by the member liveness projection. */
export const DEFAULT_MAX_SILENCE_SEC = 14_400

export type SessionTransportEvidence = SessionTransportProjection & {
  alive: boolean
  transport_alive: boolean
  agent_alive: boolean
  pid_alive: boolean
  is_silent: boolean
  answer_capability: SessionAnswerCapability
  answer_reason: SessionAnswerReason
  /** Age of the mailbox's last canonical read; null when it never read. */
  last_mailbox_read_age_ms: number | null
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
  /** A transport for this session was refused as carrying another seat's identity. */
  foreignIdentityTransport?: boolean
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
    transport_reason:
      input.foreignIdentityTransport === true
        ? "transport-carries-another-seats-identity"
        : "owner-unknown-no-transport",
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

/** Turn what the daemon can see into the consumer inputs of the answer projection. */
export function observeMailboxConsumers(input: {
  /** `sessions.delivery`, the mode registered at join. */
  readonly delivery: string | undefined
  /** A participating client is registered, so a push has a socket to reach. */
  readonly clientRegistered: boolean
  /** The mailbox owner has an inbox.wait parked right now. */
  readonly ownerWaiting: boolean
}): MailboxConsumer[] {
  const consumers: MailboxConsumer[] = []
  if (input.delivery === "push" && input.clientRegistered) consumers.push("push-client")
  if (input.ownerWaiting) consumers.push("inbox-wait")
  return consumers
}

/**
 * One PID-aware evidence projection shared by members, tracked-send admission,
 * and pending. `answer_capability` is deliberately an observation about this
 * transport snapshot, never a claim that the persona is permanently alive or
 * dead. Silence remains visible in `alive` but does not make a connected,
 * process-live transport unable to receive a new obligation.
 *
 * A live transport is not enough to be `observed` (24664): something must be
 * consuming the mailbox and the owner must be able to read it. A live seat
 * nothing is consuming reads `connected-no-consumer`. It is still reachable
 * and reads at its next tick, so the read age travels with every reason.
 * Transport reasons outrank the mailbox reason, which outranks the consumer
 * reason.
 */
export function projectSessionTransportEvidence(input: {
  transportConnected: boolean
  transportPids: readonly number[]
  agentPid: number | null
  lastSeenSec?: number | null
  maxSilenceSec?: number
  probe?: (pid: number) => OwnerState
  foreignIdentityTransport?: boolean
  consumers: readonly MailboxConsumer[]
  /** The owner's mailbox authority is registered (`mailbox_read_capability` available). */
  mailboxReadable: boolean
  /** `mailbox_cursors.last_attention_read_at` for the session NAME, the cursor's own key. */
  lastMailboxReadAt: number | null
  now?: number
}): SessionTransportEvidence {
  const probe = input.probe ?? probeProcessState
  const transportPidsAlive =
    input.transportPids.length === 0 || input.transportPids.some((pid) => probe(pid) !== "dead")
  const transport = projectSessionTransportState({
    transportConnected: input.transportConnected,
    transportPidsAlive: input.transportConnected ? transportPidsAlive : undefined,
    foreignIdentityTransport: input.foreignIdentityTransport,
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
  const answerReason: SessionAnswerReason = !input.transportConnected
    ? "owner-unknown-no-transport"
    : !transportPidsAlive
      ? "registered-transport-pids-dead"
      : !liveness.agent_alive
        ? "registered-owner-pid-dead"
        : !input.mailboxReadable
          ? "mailbox-read-unavailable"
          : input.consumers.length === 0
            ? "connected-no-consumer"
            : "connected-pid-live-transport"
  return {
    ...transport,
    ...liveness,
    answer_capability: answerReason === "connected-pid-live-transport" ? "observed" : "not-observed",
    answer_reason: answerReason,
    last_mailbox_read_age_ms:
      input.lastMailboxReadAt === null ? null : (input.now ?? Date.now()) - input.lastMailboxReadAt,
  }
}
