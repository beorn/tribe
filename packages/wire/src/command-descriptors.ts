export const TRIBE_MESSAGE_TYPES = ["assign", "status", "query", "response", "notify", "request", "verdict"] as const
export type TribeMessageType = (typeof TRIBE_MESSAGE_TYPES)[number]

export const TRIBE_FANOUTS = ["first", "all"] as const
export type TribeFanout = (typeof TRIBE_FANOUTS)[number]

export const TRIBE_DELIVERY_MODES = ["push", "pull"] as const
export type TribeDeliveryMode = (typeof TRIBE_DELIVERY_MODES)[number]

export type JsonObject = Record<string, unknown>
export type JsonSchemaObject = {
  readonly type: "object"
  readonly properties?: Record<string, unknown>
  readonly required?: readonly string[]
} & JsonObject

export interface TribeMcpTool {
  readonly name: string
  readonly description: string
  readonly inputSchema: JsonSchemaObject
  readonly outputSchema: JsonSchemaObject
  readonly _meta?: JsonObject
}

export interface TribeCliArgument {
  readonly name: string
  readonly description: string
  readonly variadic?: boolean
}

export interface TribeCliOption {
  readonly name: string
  readonly flags: string
  readonly description: string
  readonly default?: string | boolean
  readonly enum?: readonly string[]
  readonly mapsTo?: string
  readonly transform?: "duration-ms" | "csv-list"
  readonly repeatable?: boolean
  readonly requires?: readonly string[]
}

export type TribeCliProjection =
  | {
      readonly kind: "available"
      readonly name: string
      readonly description: string
      readonly lifetime: "one-shot"
      readonly mapsToMcp: string
      readonly arguments?: readonly TribeCliArgument[]
      readonly options?: readonly TribeCliOption[]
    }
  | {
      readonly kind: "hidden"
      readonly reason: string
      readonly cliName?: string
    }

export interface TribeCommandDescriptor {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly lifetime: "live-session" | "one-shot" | "diagnostic" | "operator"
  readonly mcp: TribeMcpTool
  readonly cli: TribeCliProjection
}

const ERROR_SHAPE = {
  error: { type: "string", description: "Error message - present when the tool refused or hit an exception." },
} as const

const OBJ = (properties: JsonObject, description: string): JsonSchemaObject => ({
  type: "object",
  description,
  properties,
  additionalProperties: true,
})

const ATTENTION_SCHEMA = {
  type: "object",
  description: "Current unread actionables and open response balls for the addressed persona.",
  required: ["actionable_unread", "pending_balls"],
  properties: {
    actionable_unread: {
      type: "array",
      description:
        "All unacknowledged direct request/query/verdict/assign messages for this recipient, independent of the event limit.",
      items: { type: "object", additionalProperties: true },
    },
    pending_balls: {
      type: "array",
      description:
        "Open tracked requests this recipient owns: request_id, sender, opened_at, age_ms, message_id, fanout.",
      items: { type: "object", additionalProperties: true },
    },
  },
} as const

const hidden = (reason: string, cliName?: string): TribeCliProjection => ({
  kind: "hidden",
  reason,
  ...(cliName ? { cliName } : {}),
})

const available = (
  projection: Omit<Extract<TribeCliProjection, { kind: "available" }>, "kind">,
): TribeCliProjection => ({
  kind: "available",
  ...projection,
})

export const TRIBE_COMMAND_DESCRIPTORS = [
  {
    id: "tribe.send",
    title: "Send Message",
    description: 'Send a message to one tribe member, multiple members, or everyone with to: "*".',
    lifetime: "live-session",
    mcp: {
      name: "send",
      description: 'Send a message to one tribe member, multiple members, or everyone with to: "*".',
      inputSchema: {
        type: "object",
        properties: {
          to: {
            oneOf: [{ type: "string" }, { type: "array", items: { type: "string" }, minItems: 1 }],
            description: 'Recipient session name, recipient session names, or "*" for broadcast',
          },
          message: { type: "string", description: "Message content" },
          summary: {
            type: "string",
            description:
              "Authored one-line summary - the channel UI shows it by default and discloses the markdown body on click. Required for LLM senders; non-LLM callers may omit it and the daemon derives one from the message's first line. When derived, the response includes `summary_derived: true`.",
          },
          type: {
            type: "string",
            description:
              "Message type. The tribe-wire daemon delivers every type to every session - no type is role-gated.",
            enum: TRIBE_MESSAGE_TYPES,
            default: "notify",
          },
          bead: { type: "string", description: "Associated bead ID (optional)" },
          ref: { type: "string", description: "Reference to a previous message ID (optional)" },
          request: {
            oneOf: [{ type: "string" }, { type: "boolean" }],
            description:
              "Direct request/query/assign messages automatically open a semantic recipient-owned ball using the message id. Verdict stays wakeable but does not auto-mint. Pass `true` to track any direct message type, or a non-empty string to override the request id. Recipient(s) own the ball until `reply=<id>` arrives; this is not a transport delivery ACK. See @km/tribe/message-ball-tracker.",
          },
          reply: {
            type: "string",
            description: "Ball-tracker: close the tracked request with the given id. Releases the ball.",
          },
          fanout: {
            type: "string",
            enum: TRIBE_FANOUTS,
            description:
              "Multi-recipient ball routing: 'first' (default, AMQP competing-consumers) or 'all' (per-recipient ball). Broadcast and explicit multi-target requests snapshot recipients at send time.",
            default: "first",
          },
          expires_in_ms: {
            type: "integer",
            minimum: 1,
            maximum: 24 * 60 * 60_000,
            description:
              "Sender-declared tracked-ball TTL in milliseconds. Defaults to 10 minutes; must be a positive integer no greater than one day.",
          },
        },
        required: ["to", "message"],
      },
      outputSchema: OBJ(
        {
          sent: { type: "boolean", description: "True on successful send." },
          id: { type: "string", description: "Message id assigned by the daemon." },
          ids: {
            type: "array",
            items: { type: "string" },
            description: "Per-recipient message ids for a multi-recipient send.",
          },
          request_id: {
            type: "string",
            description: "Shared explicit request id for a multi-recipient tracked send.",
          },
          tracker: {
            type: "object",
            properties: {
              request_id: { type: "string", description: "Request id handled by this reply." },
              closed: { type: "number", description: "Pending rows closed by the committed send transaction." },
            },
            required: ["request_id", "closed"],
            description: "Present for replies; reports the committed ball-tracker mutation.",
          },
          summary: {
            type: "string",
            description:
              "The one-liner stored with the message. Authored by LLM senders; derived from the message only for non-LLM callers who omit it.",
          },
          summary_derived: {
            type: "boolean",
            description: "Present and true when a non-LLM sender omitted `summary` and the daemon derived one.",
          },
          warning: { type: "string", description: "Human-readable note emitted when the summary was derived." },
          ...ERROR_SHAPE,
        },
        "Send result: { sent, id, summary, tracker? } on success (tracker for replies; summary_derived + warning when derived), { error } on validation failure.",
      ),
    },
    cli: available({
      name: "send",
      description: 'Send a message to one tribe member, multiple members, or everyone with to: "*".',
      lifetime: "one-shot",
      mapsToMcp: "send",
      arguments: [
        { name: "to", description: "Target session name" },
        { name: "message", description: "Message text", variadic: true },
      ],
      options: [
        {
          name: "type",
          flags: "-t, --type <type>",
          description: `Message type: ${TRIBE_MESSAGE_TYPES.join("|")} (default: notify)`,
          enum: TRIBE_MESSAGE_TYPES,
          default: "notify",
        },
        {
          name: "summary",
          flags: "-s, --summary <summary>",
          description:
            "Authored one-line summary shown by default in the channel UI (required for LLM senders; derived for non-LLM callers if omitted)",
        },
        {
          name: "reply",
          flags: "--reply <request_id>",
          description: "Ball-tracker: close the tracked request with this id",
        },
        {
          name: "request",
          flags: "--request [request_id]",
          description:
            "Explicitly track any direct type or override its id; direct request/query/assign auto-track, verdict does not",
        },
        {
          name: "fanout",
          flags: "--fanout <mode>",
          description: `Ball-tracker fanout mode: ${TRIBE_FANOUTS.join("|")} (default: first)`,
          enum: TRIBE_FANOUTS,
          default: "first",
        },
        {
          name: "expires-in-ms",
          flags: "--expires-in-ms <milliseconds>",
          description: "Tracked-ball TTL in milliseconds (default 10m, maximum 1d)",
          mapsTo: "expires_in_ms",
        },
      ],
    }),
  },
  {
    id: "tribe.pending",
    title: "Pending Requests",
    description:
      "Ball-tracker query: list open requests where the given owner is responsible for replying. Default owner is the caller's session. See @km/tribe/message-ball-tracker.",
    lifetime: "live-session",
    mcp: {
      name: "pending",
      description:
        "Ball-tracker query: list open requests where the given owner is responsible for replying. Default owner is the caller's session. See @km/tribe/message-ball-tracker.",
      inputSchema: {
        type: "object",
        properties: {
          all: {
            type: "boolean",
            description: "List every open request grouped by recipient owner (fleet-wide read-only attention).",
          },
          owner: {
            type: "string",
            description: "Session name that owns the open ball. Defaults to the caller's own session.",
          },
          stale_ms: {
            type: "number",
            description: "Filter to requests opened more than this many milliseconds ago (stale-detection).",
          },
          prune: {
            type: "boolean",
            description: "Delete this owner's pending requests older than stale_ms; stale_ms is required.",
          },
          close: {
            type: "string",
            description:
              "Close exactly one pending request for owner without sending a reply message. Use for mechanical cleanup after verified out-of-band completion.",
          },
        },
      },
      outputSchema: OBJ(
        {
          owner: { type: "string", description: "The session whose open requests are listed." },
          scope: { type: "string", description: "`all` for a fleet-wide projection." },
          all: { type: "boolean", description: "True for a fleet-wide projection." },
          pending: {
            type: "array",
            description:
              "Open requests. Each includes request_id, recipient, sender, summary, opened_at, age_ms, message_id, and fanout.",
            items: { type: "object", additionalProperties: true },
          },
          owners: {
            type: "array",
            description: "Fleet-wide groups: { owner, count, oldest_age_ms, pending }.",
            items: { type: "object", additionalProperties: true },
          },
          owner_count: { type: "number", description: "Number of recipient owners with open requests." },
          oldest_age_ms: { type: "number", description: "Age of the oldest returned request." },
          count: { type: "number", description: "Number of open requests in the pending list." },
          request_id: { type: "string", description: "Request id closed when `close` is used." },
          closed: { type: "number", description: "Number of pending rows closed when `close` is used." },
          ...ERROR_SHAPE,
        },
        "Pending requests for owner.",
      ),
    },
    cli: available({
      name: "pending",
      description:
        "Ball-tracker query: list open requests where the given owner is responsible for replying. Default owner is the caller's session. See @km/tribe/message-ball-tracker.",
      lifetime: "one-shot",
      mapsToMcp: "pending",
      options: [
        {
          name: "all",
          flags: "-a, --all",
          description: "List open requests across all owners, grouped by recipient",
        },
        {
          name: "json",
          flags: "--json",
          description: "Print the typed snapshot as JSON",
        },
        { name: "owner", flags: "-o, --owner <name>", description: "Owner session name (default: caller)" },
        {
          name: "stale",
          flags: "-s, --stale <duration>",
          description: "Only show requests older than this (e.g. 15m, 1h)",
          mapsTo: "stale_ms",
          transform: "duration-ms",
        },
        {
          name: "close",
          flags: "--close <request_id>",
          description: "Close one pending request for the owner after verified out-of-band completion",
          requires: ["owner"],
        },
      ],
    }),
  },
  {
    id: "tribe.inbox.wait",
    title: "Inbox Wait",
    description:
      "Long-poll the actionable inbox for a session until a request/query/assign/verdict direct message arrives or the timeout elapses. Every result carries current attention; direct notify/status/response rows are inbox-visible but do not wake this wait. Defaults to the caller's session.",
    lifetime: "live-session",
    mcp: {
      name: "inbox.wait",
      description:
        "Long-poll the actionable inbox for a session until a request/query/assign/verdict direct message arrives or the timeout elapses. Every result carries current attention; direct notify/status/response rows are inbox-visible but do not wake this wait. Defaults to the caller's session.",
      inputSchema: {
        type: "object",
        properties: {
          session: {
            type: "string",
            description: "Session name to wait on. Defaults to the caller's own session.",
          },
          timeout_ms: {
            type: "number",
            description:
              "Wait limit in milliseconds. Defaults to 30000. Effective duration may be capped by the MCP host.",
          },
        },
      },
      outputSchema: OBJ(
        {
          session: { type: "string", description: "The session that was waited on." },
          unread_count: { type: "number", description: "Actionable unread direct-message count at return time." },
          oldest_unread_age_min: { type: "number", description: "Age of the oldest actionable unread DM, in minutes." },
          oldest_unread_ts: { type: "number", description: "Oldest actionable unread DM timestamp (unix ms)." },
          waited_ms: { type: "number", description: "How long the wait lasted." },
          timed_out: { type: "boolean", description: "True when the timeout elapsed before a DM arrived." },
          aborted: { type: "boolean", description: "True when the connection closed before a DM arrived." },
          attention: ATTENTION_SCHEMA,
          ...ERROR_SHAPE,
        },
        "Inbox wait result.",
      ),
    },
    cli: available({
      name: "inbox-wait",
      description:
        "Long-poll the actionable inbox for a session until a request/query/assign/verdict direct message arrives or the timeout elapses. Every result carries current attention; direct notify/status/response rows are inbox-visible but do not wake this wait. Defaults to the caller's session.",
      lifetime: "one-shot",
      mapsToMcp: "inbox.wait",
      options: [
        {
          name: "session",
          flags: "--session <name>",
          description: "Session to inspect (default: @chief)",
          default: "@chief",
        },
        {
          name: "timeout",
          flags: "--timeout <duration>",
          description: "Wait limit (e.g. 30s, 1m, 5m)",
          default: "30s",
          mapsTo: "timeout_ms",
          transform: "duration-ms",
        },
        { name: "json", flags: "--json", description: "Emit machine-readable JSON (for hooks)" },
      ],
    }),
  },
  {
    id: "tribe.fetch",
    title: "Fetch Messages",
    description:
      "Read tribe messages. Default returns attention (unread actionables plus self-owned pending balls), drains the bounded chronological event window, and advances its cursor. ids/with/from/to reads are snapshots. since scans the journal and advances only with advance:true.",
    lifetime: "live-session",
    mcp: {
      name: "fetch",
      description:
        "Read tribe messages. Default returns attention (unread actionables plus self-owned pending balls), drains the bounded chronological event window, and advances its cursor. ids/with/from/to reads are snapshots. since scans the journal and advances only with advance:true.",
      inputSchema: {
        type: "object",
        properties: {
          ids: {
            type: "array",
            items: { type: "string" },
            description: "Fetch specific message IDs without advancing the cursor.",
          },
          topics: {
            type: "array",
            items: { type: "string" },
            description: "Optional topic globs, e.g. ['github:*', 'git:commit'].",
          },
          since: { type: "number", description: "Scan rows with rowid > since. Default mode uses the session cursor." },
          with: { type: "string", description: "Bilateral history with this session name." },
          from: { type: "string", description: "One-sided history from this sender." },
          to: { type: "string", description: "One-sided history to this recipient." },
          limit: {
            type: "number",
            description: "Max chronological event rows to return (default 50, max 500).",
          },
          advance: {
            type: "boolean",
            description: "Advance the session cursor after a since/default scan. Default: true only for default drain.",
          },
        },
      },
      outputSchema: OBJ(
        {
          attention: ATTENTION_SCHEMA,
          events: {
            type: "array",
            description:
              "Visible messages. Each: { id, rowid, type, from, to, content, bead?, ref?, ts (ISO), delivery, topic?, room_id? }.",
            items: { type: "object", additionalProperties: true },
          },
          cursor: { type: "number", description: "Highest rowid returned (or unchanged when no rows matched)." },
          ...ERROR_SHAPE,
        },
        "Default fetch result: { attention, events, cursor }; snapshot result: { events, cursor }; { error } on validation failure.",
      ),
    },
    cli: hidden(
      "MCP fetch is a live-session cursor/snapshot primitive; the existing CLI log command is a daemon-log view and must not be treated as fetch parity.",
      "log",
    ),
  },
  {
    id: "tribe.members",
    title: "Members",
    description: "List active tribe sessions with their domains",
    lifetime: "live-session",
    mcp: {
      name: "members",
      description: "List active tribe sessions with their domains",
      inputSchema: {
        type: "object",
        properties: { all: { type: "boolean", description: "Include dead sessions (default: false)" } },
      },
      outputSchema: OBJ(
        {
          sessions: {
            type: "array",
            description:
              "Per-session rows: { name, role, domains, pid, cwd, claude_session_id?, claude_session_name?, alive, uptime_min, last_seen_sec, parent? }.",
            items: { type: "object", additionalProperties: true },
          },
        },
        "Members list - array of session records under `sessions`.",
      ),
    },
    cli: hidden(
      "Not in the first descriptor-backed CLI slice; legacy CLI status/sessions are daemon diagnostics, not exact MCP members projection.",
      "sessions",
    ),
  },
  {
    id: "tribe.rename",
    title: "Rename Session",
    description: "Rename this session in the tribe",
    lifetime: "live-session",
    mcp: {
      name: "rename",
      description: "Rename this session in the tribe",
      inputSchema: {
        type: "object",
        properties: { new_name: { type: "string", description: "New session name" } },
        required: ["new_name"],
      },
      outputSchema: OBJ(
        {
          renamed: { type: "boolean" },
          old_name: { type: "string" },
          new_name: { type: "string" },
          name: { type: "string", description: "Present on rename-to-self no-op." },
          existing_names: {
            type: "array",
            items: { type: "string" },
            description: "On collision: active session names already in use.",
          },
          ...ERROR_SHAPE,
        },
        "Rename result: { renamed, old_name, new_name } on success, { renamed:false, name } on no-op, { error, existing_names? } on collision.",
      ),
    },
    cli: hidden("MCP-only live-session identity mutation; no one-shot CLI projection is defined in this slice."),
  },
  {
    id: "tribe.health",
    title: "Health",
    description: "Diagnostic: check for silent members, stale beads, unread messages",
    lifetime: "diagnostic",
    mcp: {
      name: "health",
      description: "Diagnostic: check for silent members, stale beads, unread messages",
      inputSchema: { type: "object", properties: {} },
      outputSchema: OBJ(
        {
          members: {
            type: "array",
            description: "Per-member diagnostic: { name, role, domains, pid, alive, warnings: string[], ... }.",
            items: { type: "object", additionalProperties: true },
          },
          stale_beads: { type: "number", description: "Count of beads claimed but idle past threshold." },
          unread: {
            type: "array",
            description: "Actionable direct-message counts per recipient not yet drained.",
            items: { type: "object", additionalProperties: true },
          },
          pending_balls: {
            type: "object",
            description: "All-owner pending snapshot with count, owner_count, oldest_age_ms, owners, and stale rows.",
            additionalProperties: true,
          },
          cadence: {
            type: "object",
            description:
              "Read-only 24h response latency, open-ball, live-session cursor lag, and database growth projection with evidence-bearing threshold warnings.",
            additionalProperties: true,
          },
          issues: {
            type: "array",
            description:
              "Diagnostic warnings, including stale balls plus response latency, live-session cursor lag, and configured database-growth breaches.",
            items: { type: "string" },
          },
          reconciler: {
            type: "object",
            description:
              "Optional chief-reconciler snapshot (opt-in via TRIBE_RECONCILER_SNAPSHOT env var). Field shape mirrors @km/tribe/stable-coordination L4.",
            additionalProperties: true,
          },
        },
        "Health snapshot - members + counts + cadence + optional reconciler snapshot.",
      ),
    },
    cli: hidden(
      "Legacy CLI health uses cli_health diagnostics; descriptor-backed MCP health CLI parity is outside the first slice.",
      "health",
    ),
  },
  {
    id: "tribe.join",
    title: "Join",
    description: "Join/rejoin: re-announce this session's name and domains after compaction or rejoin.",
    lifetime: "live-session",
    mcp: {
      name: "join",
      description: "Join/rejoin: re-announce this session's name and domains after compaction or rejoin.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Session name" },
          domains: {
            type: "array",
            items: { type: "string" },
            description: "Domain expertise areas, e.g. ['silvery', 'flexily'].",
          },
          delivery: {
            type: "string",
            description:
              "How this session consumes messages. 'push' sends channel notifications. 'pull' queues rows for tribe.fetch. Sender is transport-blind.",
            enum: TRIBE_DELIVERY_MODES,
          },
        },
        required: ["name"],
      },
      outputSchema: OBJ(
        {
          joined: { type: "boolean" },
          name: { type: "string" },
          role: { type: "string" },
          domains: { type: "array", items: { type: "string" } },
          delivery: { type: "string", enum: TRIBE_DELIVERY_MODES },
          previous_name: {
            type: "string",
            description: "Set when this join performed a rename relative to the prior session name.",
          },
          ...ERROR_SHAPE,
        },
        "Join result: { joined, name, role, domains, delivery, previous_name? }. { error } on name validation failure.",
      ),
    },
    cli: available({
      name: "join",
      description: "Join/rejoin: re-announce this session's name and domains after compaction or rejoin.",
      lifetime: "one-shot",
      mapsToMcp: "join",
      arguments: [{ name: "name", description: "Session name to claim, e.g. @chief or @ci" }],
      options: [
        { name: "role", flags: "-r, --role <role>", description: "Session role (default: member)", default: "member" },
        {
          name: "domain",
          flags: "-d, --domain <domain>",
          description: "Domain label; repeat or comma-separate for multiple",
          repeatable: true,
          transform: "csv-list",
        },
        {
          name: "delivery",
          flags: "--delivery <mode>",
          description: "Delivery mode: pull or push (default: pull)",
          enum: TRIBE_DELIVERY_MODES,
          default: "pull",
        },
        { name: "json", flags: "--json", description: "Emit machine-readable JSON" },
      ],
    }),
  },
  {
    id: "tribe.reload",
    title: "Reload",
    description:
      "Hot-reload the tribe MCP server - re-exec with latest code from disk. Use after tribe code is updated to pick up fixes without restarting the Claude Code session.",
    lifetime: "operator",
    mcp: {
      name: "reload",
      description:
        "Hot-reload the tribe MCP server - re-exec with latest code from disk. Use after tribe code is updated to pick up fixes without restarting the Claude Code session.",
      inputSchema: {
        type: "object",
        properties: { reason: { type: "string", description: "Why the reload is needed (logged to events)" } },
      },
      outputSchema: OBJ(
        {
          reloading: { type: "boolean" },
          reason: { type: "string" },
          pid: { type: "number", description: "PID of the daemon about to re-exec." },
        },
        "Reload acknowledgment - the actual re-exec happens shortly after this response flushes.",
      ),
    },
    cli: hidden("Legacy CLI reload exists, but reload is outside the first descriptor-backed parity slice.", "reload"),
  },
  {
    id: "tribe.retro",
    title: "Retro",
    description:
      "Generate a retrospective report analyzing tribe message history, coordination health, and per-member activity",
    lifetime: "diagnostic",
    mcp: {
      name: "retro",
      description:
        "Generate a retrospective report analyzing tribe message history, coordination health, and per-member activity",
      inputSchema: {
        type: "object",
        properties: {
          since: {
            type: "string",
            description: 'Duration to look back (e.g. "2h", "30m", "1d"). Default: entire session.',
          },
          format: { type: "string", description: "Output format", enum: ["markdown", "json"], default: "markdown" },
        },
      },
      outputSchema: OBJ(
        {
          text: {
            type: "string",
            description:
              "Markdown retro report. Present when format=markdown (default). For format=json the structured payload is the full retro report object instead - properties such as session count, message volume, per-member breakdowns.",
          },
          ...ERROR_SHAPE,
        },
        "Retro result: { text } for markdown, full report object for json, { error } on invalid duration.",
      ),
    },
    cli: hidden(
      "Legacy CLI retro reads the DB directly and is not an exact MCP retro projection in this slice.",
      "retro",
    ),
  },
  {
    id: "tribe.debug",
    title: "Debug",
    description: "Dump daemon internals for troubleshooting - clients, per-session cursors.",
    lifetime: "diagnostic",
    mcp: {
      name: "debug",
      description: "Dump daemon internals for troubleshooting - clients, per-session cursors.",
      inputSchema: { type: "object", properties: {} },
      outputSchema: OBJ(
        {
          clients: { type: "array", items: { type: "object", additionalProperties: true } },
          cursors: { type: "array", items: { type: "object", additionalProperties: true } },
        },
        "Daemon internals - shape varies by daemon build; always at least { clients, cursors }.",
      ),
    },
    cli: hidden("MCP-only diagnostic; no one-shot CLI projection is defined in this slice."),
  },
  {
    id: "tribe.repair",
    title: "Repair",
    description: "Operator-bounded daemon state repair.",
    lifetime: "operator",
    mcp: {
      name: "repair",
      description:
        "Operator repair for bounded daemon state fixes. Currently supports advancing one session's inbox cursor to the message tail without deleting history.",
      inputSchema: {
        type: "object",
        properties: {
          session: { type: "string", description: "Session name to repair. Defaults to the caller's current session." },
          inbox_cursor: {
            type: "string",
            enum: ["tail"],
            description: 'Repair mode. Use "tail" to advance the inbox cursor to the current journal tail.',
          },
        },
        required: ["inbox_cursor"],
      },
      outputSchema: OBJ(
        {
          repaired: { type: "boolean" },
          session: { type: "string" },
          repair: { type: "string" },
          cursor_before: { type: "number" },
          cursor_after: { type: "number" },
          tail: { type: "number" },
          ...ERROR_SHAPE,
        },
        "Repair result: { repaired, session, repair, cursor_before, cursor_after, tail } or { error }.",
      ),
    },
    cli: available({
      name: "repair",
      description: "Operator-bounded daemon state repair.",
      lifetime: "one-shot",
      mapsToMcp: "repair",
      options: [
        {
          name: "session",
          flags: "--session <name>",
          description: "Session to repair (default: @chief)",
          default: "@chief",
        },
        {
          name: "inbox-cursor",
          flags: "--inbox-cursor <mode>",
          description: "Inbox cursor repair mode; currently only 'tail'",
          mapsTo: "inbox_cursor",
          enum: ["tail"],
          default: "tail",
        },
        { name: "json", flags: "--json", description: "Emit machine-readable JSON" },
      ],
    }),
  },
  {
    id: "tribe.filter",
    title: "Filter",
    description:
      "Per-session filter for incoming channel events. mode controls focus level; mute stores topic globs to silence until the optional timestamp. Empty args clears the filter.",
    lifetime: "live-session",
    mcp: {
      name: "filter",
      description:
        "Per-session filter for incoming channel events. mode controls focus level; mute stores topic globs to silence until the optional timestamp. Empty args clears the filter.",
      inputSchema: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            enum: ["focus", "normal", "ambient"],
            description: "Persistent filter mode. Defaults to 'normal' when args are empty.",
          },
          mute: {
            type: "array",
            items: { type: "string" },
            description: "Optional topic globs to silence, e.g. ['github:*'].",
          },
          until: {
            type: "number",
            description: "Optional unix-ms timestamp at which mute expires. Absent = persistent.",
          },
        },
        required: [],
      },
      outputSchema: OBJ(
        {
          set: { type: "boolean" },
          mode: { type: "string", enum: ["focus", "normal", "ambient"] },
          until: { type: ["string", "null"], description: "ISO timestamp at which mute expires; null when no expiry." },
          mute: {
            type: ["array", "null"],
            items: { type: "string" },
            description: "Topic globs being silenced; null when not muting anything.",
          },
          ...ERROR_SHAPE,
        },
        "Filter result: { set, mode, until, mute } on success, { error } on argument validation failure.",
      ),
    },
    cli: hidden("MCP-only session filter; no one-shot CLI projection is defined in this slice."),
  },
  {
    id: "tribe.lifecycle.publish",
    title: "Lifecycle Publish",
    description:
      "Publish this session's latest tool-call-lifecycle snapshot. Daemon caches last-write-wins per session name; chief / observers read via tribe.lifecycle. Payload schema is opaque to the daemon (owned by the publisher).",
    lifetime: "live-session",
    mcp: {
      name: "lifecycle.publish",
      description:
        "Publish this session's latest tool-call-lifecycle snapshot. Daemon caches last-write-wins per session name; chief / observers read via tribe.lifecycle. Payload schema is opaque to the daemon (owned by the publisher).",
      inputSchema: {
        type: "object",
        properties: {
          snapshot: {
            type: "object",
            description:
              "Opaque lifecycle snapshot. Publisher-owned shape (e.g. { currentState, activeTool, elapsedMs, softDeadlineMs, hardDeadlineMs }). Daemon stores verbatim.",
            additionalProperties: true,
          },
          sessionName: {
            type: "string",
            description:
              "Attribute the snapshot to this session name (the daemon's store key). Required for multiplexing publishers - one host observing many agent sessions over a single connection - so each agent's snapshot is keyed by its own name. Omit to use the connection's own name.",
          },
        },
        required: ["snapshot"],
      },
      outputSchema: OBJ(
        {
          published: { type: "boolean" },
          sessionName: { type: "string", description: "The publishing session's tribe name (lookup key)." },
          receivedAt: { type: "string", description: "ISO timestamp when the daemon received the snapshot." },
          ...ERROR_SHAPE,
        },
        "Publish result: { published, sessionName, receivedAt } on success, { error } when the daemon's lifecycle store is unavailable or snapshot is missing.",
      ),
    },
    cli: hidden("MCP-only live lifecycle publisher; no one-shot CLI projection is defined in this slice."),
  },
  {
    id: "tribe.health.publish",
    title: "Health Publish",
    description:
      "Publish an agent recovery (force-settle / restart / rotation) as an ambient `health:recovery` broadcast (km @ag/super/20327 lateral channel). The topic is set SERVER-SIDE - clients cannot set topics via tribe.send. `content` is the human-readable summary; `agent`/`seq` are optional metadata for consumer dedup/ordering.",
    lifetime: "live-session",
    mcp: {
      name: "health.publish",
      description:
        "Publish an agent recovery (force-settle / restart / rotation) as an ambient `health:recovery` broadcast (km @ag/super/20327 lateral channel). The topic is set SERVER-SIDE - clients cannot set topics via tribe.send. `content` is the human-readable summary; `agent`/`seq` are optional metadata for consumer dedup/ordering.",
      inputSchema: {
        type: "object",
        properties: {
          content: { type: "string", description: "Human-readable recovery summary (required, non-empty)." },
          agent: { type: "string", description: "The recovering agent's tribe name (optional metadata)." },
          seq: {
            type: "number",
            description:
              "Per-agent monotonic recovery sequence from the lateral producer (optional; consumer dedup/ordering).",
          },
        },
        required: ["content"],
      },
      outputSchema: OBJ(
        {
          published: { type: "boolean" },
          id: { type: "string", description: "Message id assigned by the daemon." },
          agent: { type: "string", description: "Echo of the recovering agent's name, when supplied." },
          seq: { type: "number", description: "Echo of the recovery sequence, when supplied." },
          ...ERROR_SHAPE,
        },
        "Publish result: { published, id } on success, { error } when content is missing/empty.",
      ),
    },
    cli: hidden("MCP-only health event publisher; no one-shot CLI projection is defined in this slice."),
  },
  {
    id: "tribe.lifecycle",
    title: "Lifecycle",
    description:
      "Read the latest tool-call-lifecycle snapshot for a session (or all sessions). Diagnostic surface for chief / observers - see @km/infra/15630-stuck-agent-observability S4.",
    lifetime: "diagnostic",
    mcp: {
      name: "lifecycle",
      description:
        "Read the latest tool-call-lifecycle snapshot for a session (or all sessions). Diagnostic surface for chief / observers - see @km/infra/15630-stuck-agent-observability S4.",
      inputSchema: {
        type: "object",
        properties: {
          session: {
            type: "string",
            description: "Tribe session name (e.g. @agent/8). Omit to list every cached snapshot, newest first.",
          },
        },
      },
      outputSchema: OBJ(
        {
          session: { type: "string", description: "Echoed back when querying a single session. Omitted on list-all." },
          snapshot: {
            type: ["object", "null"],
            description:
              "Single-session result: { sessionName, sessionId, receivedAt (ISO), payload } or null when nothing has been published. Omitted on list-all.",
            additionalProperties: true,
          },
          snapshots: {
            type: "array",
            description:
              "List-all result: every cached snapshot, newest first. Omitted when querying a single session.",
            items: { type: "object", additionalProperties: true },
          },
          ...ERROR_SHAPE,
        },
        "Lifecycle result: { session, snapshot } per-session, { snapshots } list-all, { error } on validation failure.",
      ),
    },
    cli: hidden("MCP-only lifecycle reader; no one-shot CLI projection is defined in this slice."),
  },
] satisfies readonly TribeCommandDescriptor[]

export function commandDescriptorByMcpName(name: string): TribeCommandDescriptor | undefined {
  return TRIBE_COMMAND_DESCRIPTORS.find((descriptor) => descriptor.mcp.name === name)
}

export function visibleCliProjectionForMcp(name: string): Extract<TribeCliProjection, { kind: "available" }> {
  const descriptor = commandDescriptorByMcpName(name)
  if (!descriptor) throw new Error(`Unknown Tribe MCP command descriptor: ${name}`)
  if (descriptor.cli.kind !== "available") throw new Error(`Tribe MCP command ${name} has no CLI projection`)
  return descriptor.cli
}

export function cliOption(
  projection: Extract<TribeCliProjection, { kind: "available" }>,
  name: string,
): TribeCliOption {
  const option = projection.options?.find((entry) => entry.name === name)
  if (!option) throw new Error(`CLI command ${projection.name} has no option descriptor ${name}`)
  return option
}

export function cliArgument(
  projection: Extract<TribeCliProjection, { kind: "available" }>,
  name: string,
): TribeCliArgument {
  const argument = projection.arguments?.find((entry) => entry.name === name)
  if (!argument) throw new Error(`CLI command ${projection.name} has no argument descriptor ${name}`)
  return argument
}
