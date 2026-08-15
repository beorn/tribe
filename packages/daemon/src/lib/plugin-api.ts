/**
 * Tribe plugin boundary — the clean interface that separates optional observer
 * plugins (git, GitHub, health, account quotas) from the coordination daemon
 * core (tribe-daemon.ts).
 *
 * Plugins observe external signals (git commits, GitHub API, system health,
 * account quotas) and push messages onto the tribe wire. They
 * are NOT part of the daemon's core coordination responsibilities — a daemon
 * with zero plugins is a complete coordination server.
 *
 * Scope of this interface:
 *   - A plugin identifies itself with a stable `name` (also used as the sender
 *     when it broadcasts).
 *   - A plugin reports `available()` so the daemon can skip it when its
 *     dependencies (git repo, gh auth, account configuration, …) are
 *     absent.
 *   - `start(api)` wires the plugin to the tribe wire via `TribeClientApi`
 *     and returns a cleanup closure.
 *
 * What the plugin does NOT get:
 *   - Access to the SQLite database.
 *   - Access to the connected-clients map.
 *   - The daemon's session UUID.
 *   - The ability to trigger hot-reloads (the source watcher handles that).
 *
 * This matches what a future out-of-process plugin would have access to if it
 * connected as a regular tribe client: `tribe.send(to: "*", ...)`, a
 * dedup primitive, and an optional members roster for targeted alerts.
 */

import type { IncidentIdentity } from "tribe-wire"

export interface TribePluginApi {
  /** Stable identifier — also the sender name when broadcasting. */
  readonly name: string

  /** Return true if the plugin's dependencies are present. */
  available(): boolean

  /** Start observing. Returns a disposer called on daemon shutdown / hot-reload. */
  start(api: TribeClientApi): (() => void) | void

  /**
   * Opt in to fatal load semantics: a throw from `available()`/`start()` stops
   * the daemon instead of disabling just this plugin. Default (absent/false) is
   * the observer contract — the daemon serves without it. Only set this if
   * coordination is genuinely incorrect when the plugin is missing.
   */
  readonly loadBearing?: boolean

  /** Optional text appended to the MCP system prompt for connected sessions. */
  instructions?(): string
}

/** Short plugin identity used when the daemon cares only about the membership. */
export interface TribePluginHandle {
  readonly name: string
  readonly active: boolean
  /**
   * Present iff the plugin FAILED to load — the verbatim cause. Its absence on
   * an `active: false` handle means the plugin was merely unavailable
   * (dependency absent), which is a different, expected state.
   */
  readonly error?: string
}

/**
 * km-tribe.event-classification: per-emit metadata that plugins attach to
 * pick how the event should reach the agent. All fields optional — omit to
 * get default behavior (push delivery, no topic).
 *
 * `responseExpected` was removed in km-tribe.filter-collapse (v4 wire) — the
 * channel envelope now derives the reply hint at delivery time from
 * `(kind, recipient, senderRole)`.
 */
export type EventClassification = {
  /** push = eligible for per-session channel admission; pull = inbox-only */
  delivery?: "push" | "pull"
  /** Stable event topic (e.g. `git:commit`); used by tribe.filter mute globs. */
  topic?: string
}

export interface TribeClientApi {
  /**
   * Direct message to a single recipient (name) or the daemon's dispatcher.
   *
   * `incident` is the habwire stage 2(d) rail for WATCHERS: a plugin that
   * fires every tick passes the identity of the condition it observed, and the
   * daemon holds ONE obligation for as long as that condition holds instead of
   * one per observation. `active: false` is the clearing edge and closes it.
   * Without it, a ticking plugin can only emit telemetry nobody owes a reply
   * to — which is visibility, not a reader.
   */
  send(
    recipient: string,
    content: string,
    type: string,
    beadId?: string,
    classification?: EventClassification,
    incident?: IncidentIdentity & { active?: boolean },
  ): void

  /** Broadcast to all connected sessions (recipient = '*'). */
  broadcast(content: string, type: string, beadId?: string, classification?: EventClassification): void

  /**
   * Idempotent dedup claim — returns true if this caller won the claim for
   * `key`, false if another caller (or a prior run) already claimed it.
   * Used to prevent duplicate broadcasts across plugin reloads and multi-
   * instance races.
   */
  claimDedup(key: string): boolean

  /**
   * Content-prefix dedup — true if any session broadcast a message whose
   * content starts with `contentPrefix` in the recent window (≈5 min). Used
   * by plugins that want to avoid piling alerts on top of each other.
   */
  hasRecentMessage(contentPrefix: string): boolean

  /**
   * Optional: lightweight roster snapshot for plugins that need to DM a
   * specific session (e.g. CI alerts → responsible repo owner, reaper →
   * the session owning a runaway PID). Mirrors what `tribe.members` would
   * return if the plugin were an out-of-process client.
   */
  getActiveSessions(): Array<{ name: string; pid: number; role: string }>

  /** Optional: bare list of currently-connected session names. */
  getSessionNames(): string[]

  /**
   * Count + oldest-timestamp of actionable DMs addressed to `sessionName` that
   * the session has NOT drained via `tribe.fetch` yet (rowid > last_inbox_pull_seq).
   * Actionable = `type IN (request, query, verdict, assign)` and
   * `kind='direct'`.
   * Returns `{count: 0, oldestTs: 0}` when no unread or the session is unknown.
   *
   * Used by the no-live-chief authority watchdog. Generic online inbox
   * staleness consumes the richer `health.cadence.inbox_lag` projection.
   */
  getUnreadDms(sessionName: string): { count: number; oldestTs: number }
}
