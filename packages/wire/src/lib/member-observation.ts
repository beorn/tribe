/** Facts owned by Wire; agent process life belongs to its runtime. */
export type MailboxReadCapability = {
  state: "available" | "unavailable"
  evidence_kind: "observed"
  reason: "self-mailbox-authority-token" | "self-mailbox-authority-missing"
}

export type MailboxProgress =
  | {
      state: "observed"
      scope: "mailbox-name"
      observed_at_ms: number
      last_attention_read_at_ms: number
      last_attention_read_age_ms: number
    }
  | {
      state: "unobserved"
      scope: "mailbox-name"
      observed_at_ms: number
      last_attention_read_at_ms: null
      last_attention_read_age_ms: null
      reason: "no-canonical-read-receipt"
    }

export type MemberObservation = Readonly<
  Record<string, unknown> & {
    member_id: string
    name: string
    launch_id: string | null
    registration: {
      source: "durable-launch" | "connection"
      state: "registered" | "finished"
      registered_at_ms: number
    }
    transport_registered: boolean
    transport_state: "connected" | "disconnected"
    /** The registered connector process, never the agent or its supervisor. */
    owner_state: "live" | "dead" | "unknown"
    transport_reason:
      | "registered-transport"
      | "registered-transport-pids-dead"
      | "owner-unknown-no-transport"
      | "transport-carries-another-seats-identity"
    transport_observed_at_ms: number
    transport_pids: readonly number[]
    mailbox_read_capability: MailboxReadCapability
    mailbox_progress: MailboxProgress
  }
>

export type MembersObservation = Readonly<
  Record<string, unknown> & {
    schema: "tribe-members/2"
    sessions: readonly MemberObservation[]
  }
>

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function clock(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function invalid(field: string): never {
  throw new Error(`tribe.members: expected tribe-members/2 observation; invalid ${field}`)
}

/** Check the complete envelope, including retained history, without confusing
 * connector refusal PIDs with supervisor identities. */
function checkNoSupervisorFacts(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((row, index) => checkNoSupervisorFacts(row, `${path}[${index}]`))
  } else if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (["alive", "agent_alive", "pid_alive", "agent_pid", "launch_parent_pid"].includes(key)) {
        invalid(`${path}.${key}`)
      }
      checkNoSupervisorFacts(child, `${path}.${key}`)
    }
  }
}

/** One current-contract parser. A schema/acquisition failure stays a failed
 * read at the caller; it is never an empty roster or an offline verdict. */
export function parseMembersObservation(value: unknown): MembersObservation {
  if (!isRecord(value) || value.schema !== "tribe-members/2") invalid("schema")
  if (!Array.isArray(value.sessions)) invalid("sessions")
  checkNoSupervisorFacts(value, "members")
  const rows: unknown[] = value.sessions
  for (const [index, row] of rows.entries()) {
    const field = `sessions[${index}]`
    if (!isRecord(row)) invalid(field)
    if (!nonempty(row.member_id) || !nonempty(row.name)) invalid(`${field}.identity`)
    if (row.launch_id !== null && !nonempty(row.launch_id)) invalid(`${field}.launch_id`)
    if ("pid" in row) invalid(`${field}.pid`)
    const registration = row.registration
    if (
      !isRecord(registration) ||
      typeof registration.source !== "string" ||
      !["durable-launch", "connection"].includes(registration.source) ||
      typeof registration.state !== "string" ||
      !["registered", "finished"].includes(registration.state) ||
      !clock(registration.registered_at_ms)
    ) {
      invalid(`${field}.registration`)
    }
    if (
      typeof row.transport_registered !== "boolean" ||
      typeof row.transport_state !== "string" ||
      !["connected", "disconnected"].includes(row.transport_state) ||
      typeof row.owner_state !== "string" ||
      !["live", "dead", "unknown"].includes(row.owner_state) ||
      typeof row.transport_reason !== "string" ||
      ![
        "registered-transport",
        "registered-transport-pids-dead",
        "owner-unknown-no-transport",
        "transport-carries-another-seats-identity",
      ].includes(row.transport_reason) ||
      !clock(row.transport_observed_at_ms) ||
      !Array.isArray(row.transport_pids) ||
      !row.transport_pids.every((pid: unknown) => clock(pid) && pid > 0)
    ) {
      invalid(`${field}.transport`)
    }
    const capability = row.mailbox_read_capability
    if (
      !isRecord(capability) ||
      capability.evidence_kind !== "observed" ||
      !(
        (capability.state === "available" && capability.reason === "self-mailbox-authority-token") ||
        (capability.state === "unavailable" && capability.reason === "self-mailbox-authority-missing")
      )
    ) {
      invalid(`${field}.mailbox_read_capability`)
    }
    const progress = row.mailbox_progress
    if (!isRecord(progress) || progress.scope !== "mailbox-name" || !clock(progress.observed_at_ms)) {
      invalid(`${field}.mailbox_progress`)
    }
    if (progress.state === "observed") {
      if (!clock(progress.last_attention_read_at_ms) || !clock(progress.last_attention_read_age_ms)) {
        invalid(`${field}.mailbox_progress.read`)
      }
    } else if (
      progress.state !== "unobserved" ||
      progress.last_attention_read_at_ms !== null ||
      progress.last_attention_read_age_ms !== null ||
      progress.reason !== "no-canonical-read-receipt"
    ) {
      invalid(`${field}.mailbox_progress.unobserved`)
    }
  }
  return value as MembersObservation
}
