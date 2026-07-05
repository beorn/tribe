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
              "Ball-tracker: open a tracked request. Pass `true` for the convention `request_id == message_id` (most common), or a string to bind to an existing request id. Recipient(s) own the ball until a message with `reply=<id>` arrives. See @km/tribe/message-ball-tracker.",
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
        },
        required: ["to", "message"],
      },
      outputSchema: OBJ(
        {
          sent: { type: "boolean", description: "True on successful send." },
          id: { type: "string", description: "Message id assigned by the daemon." },
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
        "Send result: { sent, id, summary } on success (summary_derived + warning when derived), { error } on validation failure.",
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
          description: "Ball-tracker: open a tracked request; omit request_id to use the sent message id",
        },
        {
          name: "fanout",
          flags: "--fanout <mode>",
          description: `Ball-tracker fanout mode: ${TRIBE_FANOUTS.join("|")} (default: first)`,
          enum: TRIBE_FANOUTS,
          default: "first",
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
          owner: {
            type: "string",
            description: "Session name that owns the open ball. Defaults to the caller's own session.",
          },
          stale_ms: {
            type: "number",
            description: "Filter to requests opened more than this many milliseconds ago (stale-detection).",
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
          pending: {
            type: "array",
            description:
              "Open requests owned by this session. Each: { request_id, sender, opened_at (ISO), age_ms, message_id, fanout }.",
            items: { type: "object", additionalProperties: true },
          },
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
      "Wait-and-drain blocking receive (20843): block until a request/query/assign/verdict direct message arrives or the timeout elapses, then atomically drain the inbox and return the drained events. Ambient notify/status/health rows never wake the wait but are delivered on the timeout drain. peek:true preserves the status-only observer contract (drains nothing). Defaults to the caller's session.",
    lifetime: "live-session",
    mcp: {
      name: "inbox.wait",
      description:
        "Wait-and-drain blocking receive (20843): block until a request/query/assign/verdict direct message arrives or the timeout elapses, then atomically drain the inbox and return the drained events. Ambient notify/status/response rows never wake the wait but are delivered on the timeout drain. peek:true preserves the status-only observer contract (drains nothing). Defaults to the caller's session.",
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
              "Wait limit in milliseconds. Defaults to 30000. 0 performs one plain drain. Effective duration may be capped by the MCP host — keep MCP waits short and prefer the CLI (`tent await` / `tribe inbox-wait`) for long idle windows.",
          },
          peek: {
            type: "boolean",
            description:
              "Observer mode: return the unread status WITHOUT draining (pre-20843 contract). Internal watchers only — role idle loops must drain.",
          },
        },
      },
      outputSchema: OBJ(
        {
          session: { type: "string", description: "The session that was waited on." },
          events: {
            type: "array",
            description:
              "Drained messages (absent on peek). Each: { id, rowid, type, from, to, content, bead?, ref?, ts (ISO), delivery, topic?, room_id?, summary? }.",
            items: { type: "object", additionalProperties: true },
          },
          cursor: { type: "number", description: "Pull cursor after the drain (absent on peek)." },
          unread_count: { type: "number", description: "peek only: actionable unread direct-message count." },
          oldest_unread_age_min: { type: "number", description: "peek only: age of the oldest actionable unread DM, in minutes." },
          oldest_unread_ts: { type: "number", description: "peek only: oldest actionable unread DM timestamp (unix ms)." },
          waited_ms: { type: "number", description: "How long the wait lasted." },
          timed_out: { type: "boolean", description: "True when the timeout elapsed before an actionable DM arrived." },
          aborted: { type: "boolean", description: "True when the connection closed before a DM arrived (nothing drained)." },
          ...ERROR_SHAPE,
        },
        "Wait-and-drain result: the drained batch, or status-only on peek.",
      ),
    },
    cli: available({
      name: "inbox-wait",
      description:
        "Wait-and-drain blocking receive (20843): block until a request/query/assign/verdict direct message arrives or the timeout elapses, then atomically drain the inbox and return the drained events. Ambient notify/status/health rows never wake the wait but are delivered on the timeout drain. peek:true preserves the status-only observer contract (drains nothing). Defaults to the caller's session.",
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
        {
          name: "peek",
          flags: "--peek",
          description: "Observer mode: status only, drains nothing (pre-20843 contract; internal watchers only)",
        },
      ],
    }),
  },
  {
    id: "tribe.fetch",
    title: "Fetch Messages",
    description:
      "Read tribe messages. Default drains this session's pending queue and advances its cursor. ids/with/from/to reads are snapshots. since scans the journal and advances only with advance:true.",
    lifetime: "live-session",
    mcp: {
      name: "fetch",
      description:
        "Read tribe messages. Default drains this session's pending queue and advances its cursor. ids/with/from/to reads are snapshots. since scans the journal and advances only with advance:true.",
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
          limit: { type: "number", description: "Max rows to return (default 50, max 500)." },
          advance: {
            type: "boolean",
            description: "Advance the session cursor after a since/default scan. Default: true only for default drain.",
          },
        },
      },
      outputSchema: OBJ(
        {
          events: {
            type: "array",
            description:
              "Visible messages. Each: { id, rowid, type, from, to, content, bead?, ref?, ts (ISO), delivery, topic?, room_id? }.",
            items: { type: "object", additionalProperties: true },
          },
          cursor: { type: "number", description: "Highest rowid returned (or unchanged when no rows matched)." },
          ...ERROR_SHAPE,
        },
        "Fetch result: { events, cursor } on success, { error } on argument validation failure.",
      ),
    },
    cli: available({
      name: "fetch",
      description: "Drain the session's pending inbox once (timeout-0 alias of wait-and-drain; 20843 S2)",
      lifetime: "one-shot",
      // CLI fetch is NOT MCP-fetch parity: one-shot callers hold no live
      // session cursor connection, so it rides the wait-and-drain primitive
      // (cli_inbox_wait, timeout 0) addressed by session name. The MCP fetch
      // snapshot filters (ids/with/from/to/since) stay MCP-only; `tribe log`
      // remains the daemon-log view.
      mapsToMcp: "inbox.wait",
      options: [
        {
          name: "session",
          flags: "--session <name>",
          description: "Session to drain (default: @chief)",
          default: "@chief",
        },
        { name: "json", flags: "--json", description: "Emit machine-readable JSON" },
      ],
    }),
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
          reconciler: {
            type: "object",
            description:
              "Optional chief-reconciler snapshot (opt-in via TRIBE_RECONCILER_SNAPSHOT env var). Field shape mirrors @km/tribe/stable-coordination L4.",
            additionalProperties: true,
          },
        },
        "Health snapshot - members + counts + optional reconciler snapshot.",
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
