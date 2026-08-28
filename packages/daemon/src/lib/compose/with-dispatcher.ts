/**
 * withDispatcher — per-connection JSON-RPC dispatch loop.
 *
 * Owns:
 *   - `handleConnection(socket)` — accept-handler that creates a placeholder
 *     ClientSession, wires the line parser, and tears down on `close`.
 *   - `handleRequest(req, connId)` — JSON-RPC method router. The big switch
 *     covers `register`, every `tribe.*` coord method (delegated to
 *     `handleToolCall`), the `cli_*` introspection methods, `log_event`,
 *     `discover`, `set_state` / `get_state`, `subscribe`, plus the lore
 *     fallthrough in `default`.
 *   - The session-name resolution helpers (`adoptIdentity`,
 *     `adoptByProjectAndRole`, `resolveName`, `deduplicateName`,
 *     `applyClient`, `resetOffsetsToTail`, `announceJoin`).
 *
 * Runtime hooks injected via `withDispatcher({...})`:
 *   - `onActiveClient()` — invoked from accept (a fresh client connected).
 *     Wired to `withIdleQuit.markActive()`.
 *   - `onIdle()` — invoked when the registry empties on disconnect. Wired
 *     to `withIdleQuit.markIdle()`.
 *   - `getActivePluginNames()` — surfaced via `cli_status` for UI.
 *   - `getPluginStatus()` — the same, plus the plugins that failed to load and
 *     the cause, so `tribe status` names a disabled plugin instead of omitting it.
 *   - `getCliDaemonExtras()` / `getCliStatusExtras()` — late-bound
 *     introspection that needs runtime knobs (quitTimeout, etc.).
 *   - `suppressWindowMs` — join/leave broadcast window after hot-reload.
 *
 * The dispatcher attaches its connection handler to the bound `socket.server`
 * via `server.on("connection", handler)`.
 */

import { randomUUID, timingSafeEqual } from "node:crypto"
import { type Socket as NetSocket } from "node:net"
import { createLogger } from "loggily"
import { DEFAULT_INBOX_WAIT_SESSION, resolveInboxWaitOptions } from "tribe-wire"
import { deriveTribePersonaLaunchIdentity } from "tribe-wire/lib/persona-launch-identity"
import { AG_SESSION_AUTH_ENV, hashSelfMailboxAuthority } from "tribe-wire/lib/self-mailbox-authority"
import {
  createLineParser,
  isRequest,
  makeError,
  makeResponse,
  negotiateProtocolVersion,
  supportedProtocolVersionsFromAdvertisement,
  TRIBE_SUPPORTED_PROTOCOL_VERSIONS,
  TRIBE_PROTOCOL_VERSION,
  type JsonRpcMessage,
  type JsonRpcRequest,
} from "tribe-wire/lib/socket"
import { protocolVersionMismatchMessage } from "../../../../wire/src/lib/protocol-mismatch.ts"
import { detectRole, resolveProjectId, type TribeRole } from "tribe-wire/lib/config"
import { createTribeContext, type MessageInsertedInfo, type TribeContext } from "../context.ts"
import {
  fetchEvent,
  handleToolCall,
  isRemovedTribeMethod,
  readAttentionProjection,
  removedTribeMethodMessage,
  TRIBE_COORD_METHODS,
  type FetchRow,
} from "../handlers.ts"
import { createLifecycleStore } from "../lifecycle-store.ts"
import type { TribePluginHandle } from "../plugin-api.ts"
import { createInboxWaitManager } from "../inbox-wait.ts"
import { logEvent, sendMessage } from "../messaging.ts"
import { registerSession, NameConflictError, reapStaleTransportRows, activeLaunchIds } from "../session.ts"
import {
  adoptByPidCwd,
  adoptIdentity,
  isTombstonedSessionName,
  resolveName,
  type PriorSession,
} from "../resolve-name.ts"
import { type RecallConnState } from "../recall-handlers.ts"
import type { BaseTribe } from "./base.ts"
import type { WithBroadcast } from "./with-broadcast.ts"
import type { WithClientRegistry, ClientSession } from "./with-client-registry.ts"
import type { WithConfig } from "./with-config.ts"
import type { WithDaemonContext } from "./with-daemon-context.ts"
import type { WithDatabase } from "./with-database.ts"
import type { WithRecall } from "./with-recall.ts"
import type { WithSocketServer } from "./with-socket-server.ts"
import type { DirectDeliveryResolver } from "../delivery-resolution.ts"
import { STARTUP_SHA, TRIBE_SOURCE_ROOT } from "../code-pin.ts"
import { shouldLogSlowRequest } from "../slow-request-log.ts"
import { derivedLaunchPrefixUpperBound } from "../launch-prefix-range.ts"

const log = createLogger("tribe:dispatcher")

export interface DispatcherRuntimeHooks {
  /** Called from accept(). Default: no-op. Wire to withIdleQuit. */
  onActiveClient?: () => void
  /** Called when the registry empties on disconnect. */
  onIdle?: () => void
  /** Plugin names surfaced via cli_status. Default: empty array. */
  getActivePluginNames?: () => string[]
  /**
   * Per-plugin load outcome surfaced via cli_status, INCLUDING plugins that
   * failed to start and why. Default: empty array. Without this a plugin that
   * refused to load is indistinguishable from one that was never configured.
   */
  getPluginStatus?: () => TribePluginHandle[]
  /** Idle-quit delay (seconds) returned by cli_daemon (wire key `quitTimeout`). Default: -1. */
  getIdleQuitAfterSec?: () => number
  /** Clean daemon shutdown for `tribe.stop`. Default: absent — the handler
   * then refuses loudly instead of pretending to stop anything. */
  triggerShutdown?: () => void
  /** Suppress-window for join/leave broadcasts. Default: 10000ms (0 disables). */
  suppressWindowMs?: number
  /** Generic direct-message delivery policy supplied by the composing layer. */
  resolveDelivery?: DirectDeliveryResolver
}

/**
 * Method handler for late-bound JSON-RPC methods (e.g. MCP-spec methods
 * registered by `withMCPServer()`). Returns the result data; the dispatcher
 * wraps it in a JSON-RPC response. Throw to surface a JSON-RPC error.
 */
export type MethodHandler = (params: Record<string, unknown>, ctx: { connId: string }) => unknown | Promise<unknown>

/**
 * Per-name sliding window for user-visible session announcements. The first
 * attempt passes; every attempt re-arms its name, so a seat churning faster
 * than the window stays quiet until a later transition occurs after a full
 * quiet window. Durable lifecycle events are written independently of this
 * broadcast-only throttle.
 */
function createSessionAnnounceGate(windowMs: number): (name: string, nowMs: number) => boolean {
  const lastAttemptByName = new Map<string, number>()
  return (name, nowMs) => {
    if (windowMs <= 0) return true
    // Session names are not a fixed universe. Expire inactive entries on the
    // next announcement so transient/auto-suffixed identities are not retained
    // for the daemon lifetime.
    for (const [candidate, lastAttempt] of lastAttemptByName) {
      if (nowMs - lastAttempt >= windowMs) lastAttemptByName.delete(candidate)
    }
    const lastAttempt = lastAttemptByName.get(name)
    lastAttemptByName.set(name, nowMs)
    return lastAttempt === undefined
  }
}

export interface Dispatcher {
  /** The accept-handler the socket server invokes. */
  handleConnection: (socket: NetSocket) => void
  /** The JSON-RPC method router. Exposed for tests. */
  handleRequest: (req: JsonRpcRequest, connId: string) => Promise<string>
  /**
   * Register a late-bound method handler. Used by surfaces (e.g. MCP server)
   * that need to answer JSON-RPC methods after the dispatcher is built.
   * Late-bound methods are checked BEFORE lore in the default branch, so they
   * never conflict with the explicit `tribe.*` cases above. Re-registration
   * throws.
   */
  register: (method: string, handler: MethodHandler) => void
  /** Answer pending long-polls before the daemon closes client sockets. */
  shutdown: () => void
}

export interface WithDispatcher {
  readonly dispatcher: Dispatcher
}

function relPath(p: string): string {
  const cwd = process.cwd()
  return p.startsWith(cwd + "/") ? p.slice(cwd.length + 1) : p
}

export function withDispatcher<
  T extends BaseTribe &
    WithConfig &
    WithDatabase &
    WithDaemonContext &
    WithRecall &
    WithClientRegistry &
    WithBroadcast &
    WithSocketServer,
>(hooks: DispatcherRuntimeHooks = {}): (t: T) => T & WithDispatcher {
  return (t) => {
    const { db, stmts, daemonCtx, recall: recallHandlers, registry, broadcast, socket } = t
    const { clients, socketToClient } = registry
    const onActiveClient = hooks.onActiveClient ?? (() => {})
    const onIdle = hooks.onIdle ?? (() => {})
    const getActivePluginNames = hooks.getActivePluginNames ?? (() => [])
    const getPluginStatus = hooks.getPluginStatus ?? (() => [] as TribePluginHandle[])
    const getIdleQuitAfterSec = hooks.getIdleQuitAfterSec ?? (() => -1)
    const suppressWindowMs = hooks.suppressWindowMs ?? (process.env.TRIBE_NO_SUPPRESS ? 0 : 10_000)
    const sessionAnnounceGate = createSessionAnnounceGate(suppressWindowMs)
    const channelJoinAnnounced = new Set<string>()

    function identityLogFields(client: ClientSession): {
      connection_id: string
      member_id: string
      name: string
      role: TribeRole
      pid: number
      launch_id: string | null
      launch_parent_pid: number | null
    } {
      return {
        connection_id: client.id,
        member_id: client.ctx.sessionId,
        name: client.name,
        role: client.role,
        pid: client.pid,
        launch_id: client.launchId,
        launch_parent_pid: client.launchParentPid,
      }
    }

    function connectionLogIdentity(
      client: ClientSession | undefined,
      connId: string,
    ): ReturnType<typeof identityLogFields> | { connection_id: string } {
      if (!client || client.role === "pending") return { connection_id: connId }
      return identityLogFields(client)
    }

    function errorCode(error: Error): string {
      const code = (error as NodeJS.ErrnoException).code
      return typeof code === "string" && code.length > 0 ? code : "UNKNOWN"
    }

    const methodHandlers = new Map<string, MethodHandler>()
    function register(method: string, handler: MethodHandler): void {
      if (methodHandlers.has(method)) {
        throw new Error(`Method "${method}" already registered`)
      }
      methodHandlers.set(method, handler)
    }

    function logActivity(type: string, content: string): void {
      sendMessage(daemonCtx, "*", content, type, undefined, undefined, "broadcast", {
        delivery: "pull",
        topic: `daemon:${type}`,
      })
    }

    function readInboxStatus(sessionName: string): {
      session: string
      unread_count: number
      oldest_unread_age_min: number
      oldest_unread_ts: number
      latest_actionable_seq: number | null
      latest_message_id: string | null
      latest_type: string | null
    } {
      const { attentionRows, pendingBalls, actionableCount } = readAttentionProjection(daemonCtx, sessionName)
      const oldest = attentionRows[0]
      const latest = attentionRows.at(-1)
      const oldestPendingTs = pendingBalls.reduce(
        (oldestTs, ball) => Math.min(oldestTs, Date.parse(ball.opened_at)),
        Number.POSITIVE_INFINITY,
      )
      const unread_count = actionableCount
      const oldestTs = Math.min(oldest?.ts ?? Number.POSITIVE_INFINITY, oldestPendingTs)
      const oldest_unread_ts = Number.isFinite(oldestTs) ? oldestTs : 0
      const oldest_unread_age_min = oldest_unread_ts > 0 ? Math.floor((Date.now() - oldest_unread_ts) / 60_000) : 0
      return {
        session: sessionName,
        unread_count,
        oldest_unread_age_min,
        oldest_unread_ts,
        latest_actionable_seq: latest?.rowid ?? null,
        latest_message_id: latest?.id ?? null,
        latest_type: latest?.type ?? null,
      }
    }

    type OperatorCapabilityVerdict = "authorized" | "unconfigured" | "rejected"

    function operatorCapabilityVerdict(value: unknown): OperatorCapabilityVerdict {
      const configured = t.config.operatorCapability?.trim()
      if (!configured) return "unconfigured"
      const supplied = typeof value === "string" ? value : ""
      if (supplied.length !== configured.length) return "rejected"
      return timingSafeEqual(Buffer.from(supplied), Buffer.from(configured)) ? "authorized" : "rejected"
    }

    function requiredNonEmptyString(value: unknown): string | null {
      return typeof value === "string" && value.trim().length > 0 ? value.trim() : null
    }

    type AuthenticatedSessionCapability =
      | { kind: "inbox-ack"; limit: unknown; peek: boolean }
      | { kind: "pending-close"; owner: string; close: string | string[] }
      | { kind: "pending-prune"; owner: string; staleMs: number }

    type SessionAuthorityResolution =
      | { context: TribeContext }
      | { errorCode: number; errorMessage: string; errorData: Record<string, unknown> }

    /**
     * Resolve the launcher-minted bearer exactly once for every authenticated
     * one-shot operation. The capability union above is deliberately closed:
     * extending what this bearer may do requires a new typed member and its
     * own boundary test, never a caller-supplied method name.
     */
    function resolveSessionAuthority(value: unknown): SessionAuthorityResolution {
      const supplied = requiredNonEmptyString(value)
      if (supplied === null) {
        return {
          errorCode: -32004,
          errorMessage: `current session authority is missing; ${AG_SESSION_AUTH_ENV} must be inherited from the managed launch`,
          errorData: { kind: "could-not-evaluate", reason: "session-authority-missing" },
        }
      }
      const row = db
        .prepare(
          `SELECT id, name, role, domains, claude_session_id, claude_session_name
           FROM sessions WHERE mailbox_authority_hash = $hash`,
        )
        .get({ $hash: hashSelfMailboxAuthority(supplied) }) as {
        id: string
        name: string
        role: TribeRole
        domains: string
        claude_session_id: string | null
        claude_session_name: string | null
      } | null
      if (row === null) {
        return {
          errorCode: -32003,
          errorMessage: `current session authority was rejected or revoked; ${AG_SESSION_AUTH_ENV} did not match a live managed session`,
          errorData: { kind: "unauthenticated", reason: "session-authority-rejected" },
        }
      }
      const domains = JSON.parse(row.domains) as unknown
      if (!Array.isArray(domains) || !domains.every((domain): domain is string => typeof domain === "string")) {
        return {
          errorCode: -32603,
          errorMessage: `stored domains for ${row.name} are invalid`,
          errorData: { kind: "invalid-state", reason: "session-authority-domains-invalid" },
        }
      }
      return {
        context: createTribeContext({
          db,
          stmts,
          sessionId: row.id,
          sessionRole: row.role,
          initialName: row.name,
          domains,
          claudeSessionId: row.claude_session_id,
          claudeSessionName: row.claude_session_name,
          onMessageInserted,
        }),
      }
    }

    async function dispatchAuthenticatedSessionCapability(
      authority: unknown,
      capability: AuthenticatedSessionCapability,
      connId: string,
    ): Promise<
      | { result: Awaited<ReturnType<typeof handleToolCall>> }
      | { errorCode: number; errorMessage: string; errorData: Record<string, unknown> }
    > {
      const resolution = resolveSessionAuthority(authority)
      if (!("context" in resolution)) {
        if (capability.kind === "pending-close" || capability.kind === "pending-prune") {
          const closeIds =
            capability.kind === "pending-close"
              ? Array.isArray(capability.close)
                ? capability.close
                : [capability.close]
              : undefined
          const refusalEventId = logEvent(
            daemonCtx,
            "session.capability-refused",
            undefined,
            {
              capability: capability.kind,
              reason: resolution.errorData.reason,
              authority_env: AG_SESSION_AUTH_ENV,
              owner: capability.owner,
              ...(capability.kind === "pending-prune" ? { stale_ms: capability.staleMs } : { attempted_ids: closeIds }),
              pending_mutation: "none",
            },
            { sender: "daemon", ref: closeIds?.[0] },
          )
          return {
            ...resolution,
            errorData: { ...resolution.errorData, refusal_event_id: refusalEventId },
          }
        }
        return resolution
      }
      switch (capability.kind) {
        case "inbox-ack":
          return {
            result: await handleToolCall(
              resolution.context,
              TRIBE_COORD_METHODS.fetch,
              { limit: capability.limit, advance: capability.peek ? false : undefined },
              DAEMON_HANDLER_OPTS,
              connId,
            ),
          }
        case "pending-close":
          return {
            result: await handleToolCall(
              resolution.context,
              TRIBE_COORD_METHODS.pending,
              { owner: capability.owner, close: capability.close },
              DAEMON_HANDLER_OPTS,
              connId,
            ),
          }
        case "pending-prune":
          return {
            result: await handleToolCall(
              resolution.context,
              TRIBE_COORD_METHODS.pending,
              { owner: capability.owner, prune: true, stale_ms: capability.staleMs },
              DAEMON_HANDLER_OPTS,
              connId,
            ),
          }
        default: {
          const unreachable: never = capability
          throw new Error(`unhandled authenticated session capability: ${JSON.stringify(unreachable)}`)
        }
      }
    }

    type InboxTargetResolution =
      | { sessionName: string; launchId?: string; launchParentPid?: number }
      | { errorCode: number; errorMessage: string }

    /**
     * Resolve an inbox target from durable daemon authority. Session names are
     * accepted only as explicit operator/read targets; a managed one-shot CLI
     * supplies its launch-scoped correlation id, never mutable name hints from
     * env. The daemon derives the parent-pid half of the authoritative
     * tuple from its own persisted session row and fails closed on ambiguity.
     */
    function resolveInboxTarget(
      params: Record<string, unknown>,
      opts: { mode: "launch" } | { mode: "explicit"; defaultSession?: string },
    ): InboxTargetResolution {
      const hasSession = Object.prototype.hasOwnProperty.call(params, "session")
      const hasLaunchId = Object.prototype.hasOwnProperty.call(params, "launch_id")
      const hasLaunchParentPid = Object.prototype.hasOwnProperty.call(params, "launch_parent_pid")
      const hasLaunchParentPids = Object.prototype.hasOwnProperty.call(params, "launch_parent_pids")
      const hasPersona = Object.prototype.hasOwnProperty.call(params, "persona")
      if (opts.mode === "explicit") {
        if (hasLaunchId || hasLaunchParentPid || hasLaunchParentPids) {
          return { errorCode: -32602, errorMessage: "Explicit inbox request accepts session, not launch identity" }
        }
        if (hasSession) return { sessionName: String(params.session) }
        if (opts.defaultSession !== undefined) return { sessionName: opts.defaultSession }
        return { errorCode: -32602, errorMessage: "Explicit inbox request requires session" }
      }

      if (hasSession || hasLaunchParentPid || hasLaunchParentPids) {
        return {
          errorCode: -32602,
          errorMessage: "Managed inbox request accepts only launch_id; parent identity is daemon-derived",
        }
      }
      if (!hasLaunchId) {
        return { errorCode: -32602, errorMessage: "Managed inbox request requires a non-empty launch_id" }
      }

      const launchId = String(params.launch_id ?? "").trim()
      if (launchId.length === 0) {
        return {
          errorCode: -32602,
          errorMessage: "Managed inbox request requires a non-empty launch_id",
        }
      }
      const derivedPrefix = `${launchId}::`
      const derivedPrefixUpper = derivedLaunchPrefixUpperBound(derivedPrefix)
      if (derivedPrefixUpper === null) {
        // Unreachable: launchId is non-empty above, so the prefix is too. A
        // null bound would silently widen or void the range, so refuse rather
        // than run a query whose result would not mean what it claims.
        return { errorCode: -32602, errorMessage: "Managed inbox request requires a non-empty launch_id" }
      }
      const launchSessions = stmts.getSessionsByProviderLaunchId.all({
        $launch_id: launchId,
        $derived_prefix: derivedPrefix,
        $derived_prefix_upper: derivedPrefixUpper,
      }) as Array<{
        name: string
        launch_id: string
        launch_parent_pid: number | null
      }>
      // Tombstones retain journal addressability but no longer own routing.
      // A disconnected canonical row remains valid for managed CLI recovery.
      const routableLaunchSessions = launchSessions.filter((session) => !isTombstonedSessionName(session.name))
      const persona = hasPersona && typeof params.persona === "string" ? params.persona.trim() : ""
      if (hasPersona && persona.length === 0) {
        return { errorCode: -32602, errorMessage: "Managed inbox persona must be a non-empty string" }
      }
      // A launch can legitimately host distinct named bridges. Launch
      // authority remains the trust boundary; persona only narrows an
      // otherwise ambiguous set already proven to belong to that launch. For
      // a sole session, ignore a stale spawn-time persona so runtime rename
      // recovery retains the launch-only behavior.
      const resolvedLaunchSessions =
        routableLaunchSessions.length > 1 && persona.length > 0
          ? routableLaunchSessions.filter(
              (session) =>
                session.launch_id === deriveTribePersonaLaunchIdentity(persona, launchId).launchId ||
                (session.launch_id === launchId && session.name === persona),
            )
          : routableLaunchSessions
      const launchSession = resolvedLaunchSessions[0]
      if (resolvedLaunchSessions.length !== 1 || launchSession === undefined) {
        return {
          errorCode: -32003,
          errorMessage:
            `Inbox launch identity resolved to ${routableLaunchSessions.length} sessions (${launchSessions.length} stored)` +
            (persona.length > 0 ? `; persona ${persona} matched ${resolvedLaunchSessions.length}` : "") +
            "; exactly one routable session is required",
        }
      }
      if (!Number.isSafeInteger(launchSession.launch_parent_pid) || Number(launchSession.launch_parent_pid) <= 0) {
        return { errorCode: -32003, errorMessage: "Inbox launch identity has no authoritative parent pid" }
      }
      const persistedRename = stmts.getLaunchRename.get({
        $launch_id: launchId,
        $launch_parent_pid: launchSession.launch_parent_pid,
      }) as { name: string } | null
      if (persistedRename && persistedRename.name !== launchSession.name) {
        return {
          errorCode: -32003,
          errorMessage: "Inbox launch authorities disagree; refusing ambiguous mailbox",
        }
      }
      return {
        sessionName: launchSession.name,
        launchId: launchSession.launch_id,
        launchParentPid: Number(launchSession.launch_parent_pid),
      }
    }

    const inboxWait = createInboxWaitManager(
      readInboxStatus,
      (sessionName) => readAttentionProjection(daemonCtx, sessionName).attention,
      (sessionName, wakeOnCorrelatedReply) => {
        const latest = stmts.getLatestInboxWaitMessage.get({
          $name: sessionName,
          $include_correlated_replies: wakeOnCorrelatedReply ? 1 : 0,
          $unacknowledged_only: 0,
        }) as { rowid: number } | undefined
        return latest?.rowid ?? 0
      },
      (sessionName, wakeOnCorrelatedReply, status) => {
        const current = stmts.getLatestInboxWaitMessage.get({
          $name: sessionName,
          $include_correlated_replies: wakeOnCorrelatedReply ? 1 : 0,
          $unacknowledged_only: 1,
        }) as { rowid: number } | undefined
        return current?.rowid ?? (status.unread_count > 0 ? 1 : 0)
      },
    )
    const previousOnMessageInserted = daemonCtx.onMessageInserted
    const onMessageInserted = (info: MessageInsertedInfo) => {
      previousOnMessageInserted?.(info)
      inboxWait.onMessageInserted(info)
    }
    daemonCtx.onMessageInserted = onMessageInserted

    /** In-memory per-session lifecycle-snapshot cache. Last-write-wins;
     *  lost on daemon restart by design (sessions re-publish on the next
     *  state transition). Wired via `getLifecycleStore` so direct-handler
     *  callers (smoke harness, tests) can opt out by omitting the
     *  accessor. See `@km/infra/15630-stuck-agent-observability` § S4. */
    const lifecycleStore = createLifecycleStore()

    /**
     * Project participating sessions, not transport sockets. One managed
     * provider launch can hold several MCP transports that intentionally fan
     * into the same durable session id; exposing each socket as a session made
     * those healthy transports look like duplicate/stale role registrations.
     */
    function canonicalSessionRows(now: number) {
      const members = registry.getActiveSessionInfo()
      const transportsBySession = new Map<string, ClientSession[]>()
      for (const client of clients.values()) {
        if (client.role !== "member") continue
        const id = client.ctx.sessionId
        const transports = transportsBySession.get(id)
        if (transports) transports.push(client)
        else transportsBySession.set(id, [client])
      }

      const parentMap = new Map<string, string>()
      for (const member of members) {
        if (member.claudeSessionId && !parentMap.has(member.claudeSessionId)) {
          parentMap.set(member.claudeSessionId, member.name)
        }
      }

      return members.map((member) => {
        const transports = transportsBySession.get(member.id) ?? []
        const representative = transports.find((client) => client.pid === member.pid) ?? transports[0]
        const lastActivityAt = transports.reduce(
          (latest, client) => Math.max(latest, client.lastActivityAt),
          member.registeredAt,
        )
        const parent = member.claudeSessionId ? parentMap.get(member.claudeSessionId) : undefined
        return {
          id: member.id,
          name: member.name,
          role: member.role,
          domains: [...new Set(transports.flatMap((client) => client.domains))],
          pid: member.pid,
          transportPids: member.transportPids,
          transportCount: member.transportPids.length,
          project: member.cwd,
          projectName: representative?.projectName,
          projectId: representative?.projectId,
          claudeSessionId: member.claudeSessionId,
          peerSocket: representative?.peerSocket ?? null,
          connectedAt: member.registeredAt,
          uptimeMs: now - member.registeredAt,
          idleMs: now - lastActivityAt,
          cwd: member.cwd,
          source: "daemon" as const,
          conn: representative?.conn,
          resources: [] as string[],
          parent: parent && parent !== member.name ? parent : undefined,
          lifecycle: lifecycleStore.get(member.name) ?? null,
          protocol_versions: [...new Set(transports.flatMap((client) => client.protocolVersion ?? []))].sort(
            (a, b) => b - a,
          ),
          version_state: transports.some(
            (client) => typeof client.protocolVersion === "number" && client.protocolVersion < TRIBE_PROTOCOL_VERSION,
          )
            ? ("version-degraded" as const)
            : transports.some((client) => typeof client.protocolVersion === "number")
              ? ("current" as const)
              : ("version-unknown" as const),
        }
      })
    }

    /**
     * Attention-recovery nudge (19442, 21757) — when handleJoin / handleRename
     * detects unacknowledged attention directs waiting in the claimed name's
     * durable mailbox, fire an MCP `wakeup` notification at the claiming
     * session's live socket so push-mode clients drain immediately instead of
     * waiting for the next turn-start `tribe.fetch` (whose default drain
     * injects + acknowledges the recovered attention). Pull-mode clients
     * pick them up on their next poll regardless — the wakeup is
     * opportunistic, not load-bearing.
     */
    function notifyWakeupForReplay(sessionId: string, claimedName: string): void {
      let connId: string | undefined
      for (const [cid, c] of clients) {
        if (c.ctx.sessionId === sessionId) {
          connId = cid
          break
        }
      }
      if (!connId) return
      const tail = stmts.getMessageTailSeq.get() as { seq: number } | null
      broadcast.pushToClient(connId, "wakeup", {
        latest_seq: tail?.seq ?? null,
        reason: "actionable-recovery",
        claimed_name: claimedName,
      })
    }

    const reapStaleTransports = () => {
      const nowMs = Date.now()
      const report = reapStaleTransportRows(db, {
        nowMs,
        hasActiveTransport: (sessionId) => registry.hasActiveTransport(sessionId),
        isReconnectGraceProtected: (sessionId) => registry.isReconnectGraceProtected(sessionId, nowMs),
        getActiveLaunchIds: () => activeLaunchIds(registry.getActiveSessionInfo()),
      })
      registry.forgetTransportSessions(report.reaped_sessions.map((session) => session.member_id))
      return report
    }

    /** No-op handler opts for daemon-side tool calls. */
    const DAEMON_HANDLER_OPTS = {
      cleanup: () => {},
      userRenamed: false,
      setUserRenamed: () => {},
      getActiveSessionIds: () => registry.getActiveSessionIds(),
      hasActiveTransport: (sessionId: string) => registry.hasActiveTransport(sessionId),
      getActiveSessionInfo: () => registry.getActiveSessionInfo(),
      getLifecycleStore: () => lifecycleStore,
      inboxWait,
      notifyWakeupForReplay,
      reapStaleTransports,
      resolveDelivery: hooks.resolveDelivery,
      // tribe.stop actuator — absent (handler refuses loudly) unless the
      // composing daemon supplied its shutdown.
      triggerStop: hooks.triggerShutdown,
      getDebugState: () => ({
        clients: Array.from(clients.values()).map((c) => ({
          member_id: c.ctx.sessionId,
          name: c.name,
          role: c.role,
          pid: c.pid,
          launch_id: c.launchId,
          launch_parent_pid: c.launchParentPid,
          registeredAt: c.registeredAt,
        })),
        members: registry.getActiveSessionInfo().map((member) => ({
          member_id: member.id,
          name: member.name,
          launch_id: member.launchId,
          launch_parent_pid: member.launchParentPid,
          transport_pids: member.transportPids,
        })),
        cursors: db.prepare("SELECT id, name, last_delivered_ts, last_delivered_seq FROM sessions").all() as Array<{
          id: string
          name: string
          last_delivered_ts: number | null
          last_delivered_seq: number | null
        }>,
      }),
    } as const

    function deduplicateName(name: string): string {
      const live = Array.from(clients.values())
      const holder = live.find((c) => c.name === name)
      if (!holder) return name
      // No silent fallback. Surface the conflict so the caller picks a fresh
      // name explicitly. The connected-clients map proves the conflict; the
      // holder PID is diagnostic metadata only and must not be reused as
      // disconnected-owner identity by callers.
      const connectedNames = live.map((c) => c.name).sort()
      throw new NameConflictError(name, connectedNames, holder.pid || null)
    }

    function findSamePidNameHolder(name: string, clientPid: number, connId: string): ClientSession | null {
      if (!clientPid || clientPid <= 0) return null
      return Array.from(clients.values()).find((c) => c.id !== connId && c.name === name && c.pid === clientPid) ?? null
    }

    type LaunchIdentity = { id: string; parentPid: number }

    function claimLaunchTakeover(name: string, launch: LaunchIdentity, connId: string): boolean {
      const result = stmts.claimDedup.run({
        $key: `launch-takeover:${JSON.stringify([name, launch.id, launch.parentPid])}`,
        $session_id: connId,
        $ts: Date.now(),
      })
      return result.changes > 0
    }

    function findLaunchFanIn(
      name: string,
      clientPid: number,
      launchIdentity: LaunchIdentity | null,
      connId: string,
    ): { holder: ClientSession; launch: LaunchIdentity; transportClass: string } | null {
      for (const holder of clients.values()) {
        if (holder.id === connId || holder.name !== name) continue

        const holderLaunch =
          holder.launchId !== null && holder.launchParentPid !== null
            ? { id: holder.launchId, parentPid: holder.launchParentPid }
            : null
        if (
          launchIdentity !== null &&
          holderLaunch !== null &&
          holderLaunch.id === launchIdentity.id &&
          holderLaunch.parentPid === launchIdentity.parentPid
        ) {
          return { holder, launch: launchIdentity, transportClass: "same-launch-fan-in" }
        }

        const launchChildFoundLegacyParent =
          launchIdentity !== null && holderLaunch === null && holder.pid === launchIdentity.parentPid
        if (launchChildFoundLegacyParent) {
          return { holder, launch: launchIdentity, transportClass: "provider-parent-fan-in" }
        }

        const legacyParentFoundLaunchChild = launchIdentity === null && clientPid === holderLaunch?.parentPid
        if (legacyParentFoundLaunchChild) {
          return { holder, launch: holderLaunch, transportClass: "provider-parent-fan-in" }
        }
      }
      return null
    }

    function promoteSessionLaunchIdentity(
      sessionId: string,
      launch: LaunchIdentity,
      identityToken: string | null,
    ): void {
      const result = stmts.promoteSessionLaunchIdentity.run({
        $id: sessionId,
        $identity_token: identityToken,
        $launch_id: launch.id,
        $launch_parent_pid: launch.parentPid,
        $now: Date.now(),
      })
      if (result.changes !== 1) {
        throw new Error(`refusing launch fan-in for ${sessionId}: persisted launch identity disagrees`)
      }
      for (const sibling of clients.values()) {
        if (sibling.ctx.sessionId !== sessionId) continue
        sibling.launchId = launch.id
        sibling.launchParentPid = launch.parentPid
      }
    }

    function retireReplacedClient(client: ClientSession, reason: TransportRetirementReason): void {
      log.debug?.("transport.retired", {
        ...identityLogFields(client),
        reason,
      })
      broadcast.flushConnection(client.id)
      broadcast.discardConnection(client.id)
      channelJoinAnnounced.delete(client.id)
      clients.delete(client.id)
      socketToClient.delete(client.socket)
      if (recallHandlers) recallHandlers.dropConn(client.recall.sessionId)
      client.socket.destroy()
    }

    function applyClient(
      connId: string,
      fields: {
        name: string
        role: TribeRole
        domains: string[]
        project: string
        projectName: string
        projectId: string
        pid: number
        launchId: string | null
        launchParentPid: number | null
        claudeSessionId: string | null
        peerSocket: string | null
        ctx: TribeContext
        protocolVersion: number | null
      },
    ): ClientSession {
      const existing = clients.get(connId)
      if (existing === undefined) throw new Error(`cannot apply unknown client ${connId}`)
      const client: ClientSession = {
        socket: existing.socket,
        id: connId,
        name: fields.name,
        role: fields.role,
        domains: fields.domains,
        project: fields.project,
        projectName: fields.projectName,
        projectId: fields.projectId,
        pid: fields.pid,
        launchId: fields.launchId,
        launchParentPid: fields.launchParentPid,
        claudeSessionId: fields.claudeSessionId,
        peerSocket: fields.peerSocket,
        conn: relPath(socket.socketPath),
        ctx: fields.ctx,
        registeredAt: Date.now(),
        lastActivityAt: Date.now(),
        recall: existing.recall,
        protocolVersion: fields.protocolVersion,
      }
      clients.set(connId, client)
      onActiveClient()
      return client
    }

    function resetOffsetsToTail(client: ClientSession): void {
      const latest = stmts.getMessageTailSeq.get() as { seq: number } | null
      const tailSeq = latest?.seq ?? 0
      stmts.resetSessionDeliveryOffsets.run({ $id: client.ctx.sessionId, $ts: Date.now(), $seq: tailSeq })
    }

    function announceJoin(client: ClientSession): void {
      const now = Date.now()
      const gateOpen = sessionAnnounceGate(client.name, now)
      if (now - socket.startedAt <= suppressWindowMs || !gateOpen) return
      let parentName: string | null = null
      if (client.claudeSessionId) {
        for (const [cid, c] of clients) {
          if (cid !== client.id && c.claudeSessionId === client.claudeSessionId) {
            parentName = c.name
            break
          }
        }
      }
      const shortProject = client.project.replace(process.env.HOME ?? "", "~")
      const suffix = parentName ? ` (sub-agent of ${parentName})` : ""
      logActivity("session", `${client.name} joined (${client.role}) pid=${client.pid} ${shortProject}${suffix}`)
      channelJoinAnnounced.add(client.id)
    }

    /**
     * Times every request and names the slow ones, then delegates. This wraps
     * the router rather than sitting at a call site because there are two
     * entry points: the socket line-parser below, and `tools/call` from the
     * MCP surface, which reaches the same router directly (daemon.ts). Timing
     * only the socket path left MCP untimed — and MCP `members` was one of the
     * calls observed timing out, so the transport whose slowness was reported
     * was the one the log could not see.
     */
    async function handleRequest(req: JsonRpcRequest, connId: string): Promise<string> {
      const startedAt = Date.now()
      try {
        return await dispatchRequest(req, connId)
      } finally {
        // Clients give up on a fixed 10s timer (wire client.ts) and can report
        // only that the call did not return, so from the outside every wedge
        // looks alike. A stack walk cannot settle it either — yama
        // ptrace_scope blocks strace/perf on this host — which leaves the
        // daemon's own log as the evidence that survives.
        const elapsed = Date.now() - startedAt
        if (shouldLogSlowRequest(req.method, elapsed)) {
          log.warn?.("operation.slow", {
            ...connectionLogIdentity(clients.get(connId), connId),
            operation: operationLogName(req.method),
            duration_ms: elapsed,
          })
        }
      }
    }

    async function dispatchRequest(req: JsonRpcRequest, connId: string): Promise<string> {
      const { method, params, id } = req
      const p = (params ?? {}) as Record<string, unknown>

      // Touch lastActivityAt for THIS client on every inbound request —
      // drives the idle column in `tribe sessions` / `tribe health`.
      // Spec: @km/tribe/15588-tribe-list-sessions.
      const liveClient = clients.get(connId)
      if (liveClient) liveClient.lastActivityAt = Date.now()
      if (liveClient && liveClient.role !== "pending" && method !== "register") {
        log.info?.("operation.received", {
          ...identityLogFields(liveClient),
          direction: "inbound",
          operation: operationLogName(method),
        })
      }

      try {
        switch (method) {
          case "register": {
            const clientProtocolVersion = p.protocolVersion === undefined ? undefined : Number(p.protocolVersion)
            const clientProtocolVersions = supportedProtocolVersionsFromAdvertisement(
              p.supportedProtocolVersions,
              clientProtocolVersion,
            )
            const negotiatedProtocolVersion =
              clientProtocolVersion === undefined && p.supportedProtocolVersions === undefined
                ? undefined
                : negotiateProtocolVersion(clientProtocolVersions)
            if (negotiatedProtocolVersion === null) {
              return makeError(
                id,
                -32006,
                protocolVersionMismatchMessage(clientProtocolVersions, TRIBE_SUPPORTED_PROTOCOL_VERSIONS),
              )
            }
            const filterMode = p.filterMode
            if (filterMode !== undefined && !isSessionFilterMode(filterMode)) {
              return makeError(id, -32602, "register filterMode must be one of focus|normal|ambient")
            }
            const claudeSessionName = (p.claudeSessionName as string) ?? null
            const claudeSessionId = (p.claudeSessionId as string) ?? null
            const identityToken = (p.identityToken as string) ?? null
            const mailboxAuthorityHash =
              typeof p.mailboxAuthorityHash === "string" && /^[a-f0-9]{64}$/u.test(p.mailboxAuthorityHash)
                ? p.mailboxAuthorityHash
                : null
            if (p.mailboxAuthorityHash !== undefined && mailboxAuthorityHash === null) {
              return makeError(id, -32602, "register mailboxAuthorityHash must be a lowercase SHA-256 hex digest")
            }
            const hasLaunchId = p.launchId !== undefined && p.launchId !== null
            const hasLaunchParentPid = p.launchParentPid !== undefined && p.launchParentPid !== null
            if (hasLaunchId !== hasLaunchParentPid) {
              return makeError(
                id,
                -32602,
                "register requires launchId and launchParentPid together; omit both for legacy transport registration",
              )
            }
            const launchIdRaw = typeof p.launchId === "string" ? p.launchId.trim() : ""
            const launchParentPidRaw = Number(p.launchParentPid ?? 0)
            const launchIdentityValid =
              launchIdRaw.length > 0 && Number.isSafeInteger(launchParentPidRaw) && launchParentPidRaw > 0
            if (hasLaunchId && !launchIdentityValid) {
              return makeError(
                id,
                -32602,
                "register launch identity requires a non-empty launchId and positive integer launchParentPid; omit both for legacy transport registration",
              )
            }
            // Only complete absence selects legacy per-transport semantics.
            const launchIdentity = launchIdentityValid ? { id: launchIdRaw, parentPid: launchParentPidRaw } : null

            let role = detectRole(db, { role: p.role as string | undefined })
            if (role === "daemon" || role === "pending") role = "member"

            const isActive = (sid: string): boolean => Array.from(clients.values()).some((c) => c.ctx.sessionId === sid)

            // 15413 — daemon-restart-reconnect adoption. When the daemon
            // SIGHUP-re-execs, the listening socket fd survives but the
            // previously-accepted client connections close on the old
            // process's exit. Adapters reconnect; without this lookup the
            // fresh accept() looks like a brand-new session and the auto-
            // namer re-issues agentN — severing the prior name + chief-claim
            // mapping. (pid, cwd) is the safe key here: same client process
            // → same OS pid + cwd. Falls back to identityToken (weaker —
            // sha256(claude_session_id|cwd|role); see the 2026-05-14
            // adoption-by-identityToken removal note in resolve-name.ts).
            const clientPid = Number(p.pid ?? 0)
            const clientCwd = String(p.project ?? "")
            const pidCwdAdopted = adoptByPidCwd(db, clientPid, clientCwd, isActive)
            const launchPersisted =
              launchIdentity && typeof p.name === "string"
                ? (db
                    .prepare(
                      `SELECT id, name, role FROM sessions
                       WHERE name = ? AND launch_id = ? AND launch_parent_pid = ?
                       LIMIT 1`,
                    )
                    .get(p.name, launchIdentity.id, launchIdentity.parentPid) as PriorSession | null)
                : null
            const launchAdopted = launchPersisted && !isActive(launchPersisted.id) ? launchPersisted : null
            // A validated launch identity is stronger than the legacy weak
            // identity token. Never let a new launch with different provenance
            // adopt a dead member merely because cwd/role hashed the same.
            let adopted: PriorSession | null = launchIdentity
              ? (pidCwdAdopted ?? launchAdopted)
              : (pidCwdAdopted ?? adoptIdentity(db, identityToken, isActive))

            if (!p.role && adopted?.role) {
              const adoptedRole = adopted.role
              if (adoptedRole === "member" || adoptedRole === "watch") {
                role = adoptedRole
              }
            }

            const project = String(p.project ?? process.cwd())
            const projectName = String(p.projectName ?? project.split("/").pop() ?? "unknown")
            const projectId = String(p.projectId ?? resolveProjectId(project))
            const domains = (p.domains as string[]) ?? []
            const peerSocket = (p.peerSocket as string) ?? null

            // Names currently held by live (connected) clients — flavor
            // auto-numbering picks the lowest free integer among these.
            // Counting connected sessions (not DB rows) means a disconnected
            // codex frees `codex1` for the next spawn.
            const takenNames = new Set(Array.from(clients.values()).map((c) => c.name))
            // 15413 — when we adopted via (pid, cwd), inject the prior name
            // into resolveName's param so its existing "p.name set → return
            // verbatim" path picks it up. This is intentionally NOT done for
            // identityToken-only matches (the 2026-05-14 ban on adoption-by-
            // identityToken still stands — only the strictly-stable (pid,
            // cwd) form gets to override the name).
            const pForResolve = pidCwdAdopted ? { ...p, name: pidCwdAdopted.name } : p
            let resolvedName = resolveName({
              db,
              p: pForResolve,
              adopted,
              claudeSessionName,
              claudeSessionId,
              role,
              isActive,
              projectId,
              takenNames,
            })
            // 21454 — re-apply a persisted runtime rename. tribe.rename /
            // explicit tribe.join wrote the session's chosen name through to
            // `launch_renames` keyed by launch identity; the adapter's register
            // params still carry the frozen SPAWN-TIME name, so without this a
            // reconnect or daemon-restart re-register silently reverts the
            // identity (three chief-rename losses, 2026-07-17). Guard: never
            // adopt a name held by a LIVE session of a DIFFERENT launch — a
            // demoted predecessor reconnecting must not displace the current
            // legitimate holder.
            if (launchIdentity) {
              const persistedRename = stmts.getLaunchRename.get({
                $launch_id: launchIdentity.id,
                $launch_parent_pid: launchIdentity.parentPid,
              }) as { name: string } | null
              if (persistedRename && persistedRename.name !== resolvedName) {
                const liveHolder = Array.from(clients.values()).find(
                  (client) => client.id !== connId && client.name === persistedRename.name,
                )
                const differentLaunchHolder =
                  liveHolder !== undefined &&
                  !(
                    liveHolder.launchId === launchIdentity.id && liveHolder.launchParentPid === launchIdentity.parentPid
                  )
                if (differentLaunchHolder) {
                  log.warn?.(
                    `persisted rename "${persistedRename.name}" for launch ${launchIdentity.id} is held by a live different-launch session; registering as "${resolvedName}"`,
                  )
                } else {
                  log.info?.(
                    `re-applied persisted runtime rename: ${resolvedName} → ${persistedRename.name} (launch ${launchIdentity.id})`,
                  )
                  resolvedName = persistedRename.name
                }
              }
            }
            const launchFanIn = findLaunchFanIn(resolvedName, clientPid, launchIdentity, connId)
            if (launchFanIn) {
              const { holder, launch, transportClass } = launchFanIn
              // Backfill the durable one-shot fence when multiple transports
              // from a launch fan in before any cross-launch contention.
              if (p.takeover === true && typeof p.name === "string") {
                claimLaunchTakeover(resolvedName, launch, connId)
              }
              promoteSessionLaunchIdentity(holder.ctx.sessionId, launch, identityToken)
              if (filterMode !== undefined) applyLaunchDeclaredFilter(holder.ctx, filterMode)
              const client = applyClient(connId, {
                name: holder.name,
                role: holder.role,
                domains: holder.domains,
                project,
                projectName,
                projectId,
                pid: clientPid,
                launchId: launch.id,
                launchParentPid: launch.parentPid,
                claudeSessionId,
                peerSocket,
                ctx: holder.ctx,
                protocolVersion: negotiatedProtocolVersion ?? null,
              })
              registry.markTransportConnected(client.ctx.sessionId)
              log.debug?.("transport.attached", {
                ...identityLogFields(client),
                operation: "register",
                transport_class: transportClass,
              })
              const coordState = db
                .prepare("SELECT key, value FROM coordination WHERE project_id = ?")
                .all(projectId) as Array<{ key: string; value: string | null }>
              return makeResponse(id, {
                sessionId: client.ctx.sessionId,
                name: client.name,
                role: client.role,
                protocolVersion: negotiatedProtocolVersion ?? TRIBE_PROTOCOL_VERSION,
                supportedProtocolVersions: [...TRIBE_SUPPORTED_PROTOCOL_VERSIONS],
                coordinationState: coordState,
                daemon: { pid: process.pid, uptime: Math.floor((Date.now() - socket.startedAt) / 1000) },
              })
            }
            const samePidHolder = findSamePidNameHolder(resolvedName, clientPid, connId)
            if (samePidHolder) {
              adopted = { id: samePidHolder.ctx.sessionId, name: samePidHolder.name, role: samePidHolder.role }
              if (!p.role && (samePidHolder.role === "member" || samePidHolder.role === "watch")) {
                role = samePidHolder.role
              }
              log.info?.(`Replacing live self-registration for ${resolvedName} pid=${clientPid}`)
              retireReplacedClient(samePidHolder, "self-registration-replaced")
            }

            // 20703 — explicit-persona takeover. A managed respawn (adapter sends
            // takeover=true only for explicit @persona launch names) supersedes a
            // LIVE holder of the same name instead of failing loud: a stale MCP
            // child from a replaced/ad-hoc parent session must not squat a numbered
            // worker identity until a human kills it. The retired holder's socket is
            // destroyed; when that stale child reconnects and re-registers, it hits
            // the normal conflict path below and exits nonzero (c0b8caf) — the
            // squatter dies cleanly. Non-takeover registrations keep fail-loud
            // semantics via deduplicateName. Guarded on an explicit requested name
            // so auto-named sessions can never steal.
            if (p.takeover === true && typeof p.name === "string") {
              // TRIBE_TAKEOVER is inherited by every MCP adapter in one
              // provider launch. Treat it as a launch-scoped, durable
              // capability: the first registration consumes it, including a
              // no-contention registration. Otherwise a fresh adapter from a
              // displaced launch can replay the env bit and steal the persona
              // back from its deliberate successor (21049).
              const takeoverAuthorized = !launchIdentity || claimLaunchTakeover(resolvedName, launchIdentity, connId)
              const holders = Array.from(clients.values()).filter(
                (client) => client.id !== connId && client.name === resolvedName,
              )
              const holder = holders[0]
              if (holder && takeoverAuthorized) {
                const oldPids = [...new Set(holders.map((client) => client.pid))]
                log.warn?.(
                  `takeover: superseding live holder of "${resolvedName}" (old pid ${holder.pid}, old pids ${oldPids.join(",")}, old session ${holder.ctx.sessionId}, new pid ${clientPid})`,
                )
                logEvent(holder.ctx, "session.superseded", undefined, {
                  name: resolvedName,
                  old_pid: holder.pid,
                  old_pids: oldPids,
                  new_pid: clientPid,
                  reason: "explicit-persona takeover (20703)",
                })
                for (const replaced of holders) retireReplacedClient(replaced, "explicit-takeover")
              } else if (holder) {
                log.warn?.(
                  `takeover replay refused for "${resolvedName}" (launch ${launchIdentity?.id ?? "legacy"}, holder pid ${holder.pid}, claimant pid ${clientPid})`,
                )
              }
            }

            // 21052 — asymmetric identity displacement. A token-BEARING explicit-
            // persona claim supersedes a token-LESS live holder WITHOUT takeover:
            // unmanaged carriers (CLI drains register with no identityToken) can
            // grab a persona name across a daemon restart and then the managed
            // adapter's re-register conflict exit — 20703's squatter cleanup,
            // correct for adapter-vs-adapter — permanently kills the wrong party
            // (the 19442 agent/4 adapter death). One-directional by construction:
            // a token-less claimant never displaces anyone, and token-vs-token
            // keeps fail-loud semantics, so 21049's mutual-eviction loop stays
            // impossible.
            if (typeof p.name === "string" && identityToken) {
              const holder = Array.from(clients.values()).find((c) => c.id !== connId && c.name === resolvedName)
              if (holder) {
                const holderRow = db
                  .prepare("SELECT identity_token FROM sessions WHERE id = ?")
                  .get(holder.ctx.sessionId) as { identity_token: string | null } | null
                if (!holderRow?.identity_token) {
                  log.warn?.(
                    `identity displacement: superseding token-less holder of "${resolvedName}" (old pid ${holder.pid}, old session ${holder.ctx.sessionId}, new pid ${clientPid})`,
                  )
                  logEvent(holder.ctx, "session.superseded", undefined, {
                    name: resolvedName,
                    old_pid: holder.pid,
                    new_pid: clientPid,
                    reason: "identity displacement of token-less holder (21052)",
                  })
                  retireReplacedClient(holder, "identity-displacement")
                }
              }
            }

            const name = deduplicateName(resolvedName)
            const pid = Number(p.pid ?? 0)

            const clientCtx = createTribeContext({
              db,
              stmts,
              sessionId: adopted?.id ?? randomUUID(),
              sessionRole: role,
              initialName: name,
              domains,
              claudeSessionId,
              claudeSessionName,
              onMessageInserted,
            })

            const deliveryRaw = (p.delivery as string) ?? "push"
            const delivery: "push" | "pull" = deliveryRaw === "pull" ? "pull" : "push"
            // @km/infra/15641 Phase 1 — per-session account/provider label
            // sourced from `ag` (which sets TRIBE_ACCOUNT/TRIBE_PROVIDER env
            // vars at backend-launch time). Tribe just stores the label so
            // tribe.members can answer "which account is each session on?";
            // quota poll + threshold logic live in ag, not tribe.
            const account = typeof p.account === "string" ? p.account : null
            const provider = typeof p.provider === "string" ? p.provider : null
            registerSession(
              clientCtx,
              projectId,
              (sid) => registry.hasActiveTransport(sid),
              identityToken,
              pid,
              delivery,
              project,
              account,
              provider,
              launchIdentity?.id ?? null,
              launchIdentity?.parentPid ?? null,
              mailboxAuthorityHash,
            )
            // Apply launch-declared admission before applyClient makes this
            // session visible to the broadcast fanout. Omission preserves a
            // reconnecting session's stored preference; an explicit mode is
            // authoritative and clears stale time/topic dimensions.
            if (filterMode !== undefined) applyLaunchDeclaredFilter(clientCtx, filterMode)

            const client = applyClient(connId, {
              name,
              role,
              domains,
              project,
              projectName,
              projectId,
              pid,
              launchId: launchIdentity?.id ?? null,
              launchParentPid: launchIdentity?.parentPid ?? null,
              claudeSessionId,
              peerSocket,
              ctx: clientCtx,
              protocolVersion: negotiatedProtocolVersion ?? null,
            })
            registry.markTransportConnected(client.ctx.sessionId)

            resetOffsetsToTail(client)
            announceJoin(client)
            log.info?.("session.identified", {
              ...identityLogFields(client),
              operation: "register",
            })

            const coordState = db
              .prepare("SELECT key, value FROM coordination WHERE project_id = ?")
              .all(projectId) as Array<{ key: string; value: string | null }>

            return makeResponse(id, {
              sessionId: clientCtx.sessionId,
              name,
              role,
              protocolVersion: negotiatedProtocolVersion ?? TRIBE_PROTOCOL_VERSION,
              supportedProtocolVersions: [...TRIBE_SUPPORTED_PROTOCOL_VERSIONS],
              coordinationState: coordState,
              daemon: { pid: process.pid, uptime: Math.floor((Date.now() - socket.startedAt) / 1000) },
            })
          }

          case "host_turn_started_v1": {
            const client = clients.get(connId)
            if (client?.role !== "member" || client.launchId === null || client.launchParentPid === null) {
              return makeError(id, -32003, "Turn-start receipt requires a launch-authenticated member connection")
            }
            if (
              Object.prototype.hasOwnProperty.call(p, "session") ||
              Object.prototype.hasOwnProperty.call(p, "session_name") ||
              Object.prototype.hasOwnProperty.call(p, "launch_id") ||
              Object.prototype.hasOwnProperty.call(p, "launch_parent_pid")
            ) {
              return makeError(id, -32602, "Turn-start receipt session and launch identity are daemon-derived")
            }
            const controllerSessionId = requiredNonEmptyString(p.controller_session_id)
            const providerSessionId = requiredNonEmptyString(p.provider_session_id)
            const providerTurnId = requiredNonEmptyString(p.provider_turn_id)
            const startedAt = p.started_at
            if (controllerSessionId === null || providerSessionId === null || providerTurnId === null) {
              return makeError(
                id,
                -32602,
                "Turn-start receipt requires non-empty controller_session_id, provider_session_id, and provider_turn_id",
              )
            }
            if (!Number.isSafeInteger(startedAt) || Number(startedAt) < 0) {
              return makeError(id, -32602, "Turn-start receipt started_at must be a non-negative safe integer")
            }
            const receivedAt = Date.now()
            const inserted = stmts.insertTurnStartReceipt.run({
              $session: client.name,
              $launch_id: client.launchId,
              $launch_parent_pid: client.launchParentPid,
              $controller_session_id: controllerSessionId,
              $provider_session_id: providerSessionId,
              $provider_turn_id: providerTurnId,
              $started_at: Number(startedAt),
              $received_at: receivedAt,
            })
            return makeResponse(id, {
              recorded: true,
              duplicate: inserted.changes === 0,
              session: client.name,
              launch_id: client.launchId,
              launch_parent_pid: client.launchParentPid,
              received_at: receivedAt,
            })
          }

          case "cli_turn_start_receipt_by_launch_v1": {
            const target = resolveInboxTarget(p, { mode: "launch" })
            if ("errorCode" in target) return makeError(id, target.errorCode, target.errorMessage)
            if (target.launchId === undefined || target.launchParentPid === undefined) {
              return makeError(id, -32003, "Turn-start receipt launch authority is incomplete")
            }
            const receipt = stmts.getLatestTurnStartReceipt.get({
              $session: target.sessionName,
              $launch_id: target.launchId,
              $launch_parent_pid: target.launchParentPid,
            }) as Record<string, unknown> | null
            return makeResponse(id, {
              session: target.sessionName,
              launch_id: target.launchId,
              launch_parent_pid: target.launchParentPid,
              receipt_seq: receipt?.receipt_seq ?? null,
              controller_session_id: receipt?.controller_session_id ?? null,
              provider_session_id: receipt?.provider_session_id ?? null,
              provider_turn_id: receipt?.provider_turn_id ?? null,
              started_at: receipt?.started_at ?? null,
              received_at: receipt?.received_at ?? null,
            })
          }

          case TRIBE_COORD_METHODS.send:
          case TRIBE_COORD_METHODS.fetch:
          case TRIBE_COORD_METHODS.members:
          case TRIBE_COORD_METHODS.rename:
          case TRIBE_COORD_METHODS.join:
          case TRIBE_COORD_METHODS.health:
          case TRIBE_COORD_METHODS.restart:
          case TRIBE_COORD_METHODS.stop:
          case TRIBE_COORD_METHODS.retro:
          case TRIBE_COORD_METHODS.debug:
          case TRIBE_COORD_METHODS.repair:
          case TRIBE_COORD_METHODS.filter:
          case TRIBE_COORD_METHODS.lifecyclePublish:
          case TRIBE_COORD_METHODS.healthPublish:
          case TRIBE_COORD_METHODS.lifecycle:
          case TRIBE_COORD_METHODS.pending: {
            const client = clients.get(connId)
            const ctx = client?.ctx ?? daemonCtx
            const result = await handleToolCall(ctx, method, p, DAEMON_HANDLER_OPTS, connId)
            if ((method === TRIBE_COORD_METHODS.join || method === TRIBE_COORD_METHODS.rename) && client) {
              client.name = ctx.getName()
              client.role = ctx.getRole()
            }
            return makeResponse(id, result)
          }

          case "cli_protocol": {
            return makeResponse(id, {
              protocol_version: TRIBE_PROTOCOL_VERSION,
              supported_protocol_versions: [...TRIBE_SUPPORTED_PROTOCOL_VERSIONS],
            })
          }

          case "cli_status": {
            const now = Date.now()
            const sessions = canonicalSessionRows(now)
            return makeResponse(id, {
              sessions,
              daemon: {
                pid: process.pid,
                uptime: Math.floor((Date.now() - socket.startedAt) / 1000),
                clients: clients.size,
                dbPath: t.config.dbPath,
                socketPath: socket.socketPath,
                resources: getActivePluginNames(),
                plugins: getPluginStatus(),
                code_identity: { cert: STARTUP_SHA, root: TRIBE_SOURCE_ROOT },
                protocol_version: TRIBE_PROTOCOL_VERSION,
              },
            })
          }

          case "cli_health": {
            const health = await handleToolCall(daemonCtx, TRIBE_COORD_METHODS.health, {}, DAEMON_HANDLER_OPTS)
            const { getHealthSnapshot } = await import("../health-monitor-plugin.ts")
            let machine: unknown = null
            try {
              machine = await getHealthSnapshot()
            } catch {
              /* health snapshot unavailable */
            }
            // 15588: fold the live roster into the health response so chief
            // can answer "who is connected / who is idle >15min" with one
            // command. Same shape as the cli_status response — name,
            // role, pid, cwd, idleMs, uptimeMs — minus the bookkeeping
            // fields (peerSocket, conn, projectId, etc.) that aren't
            // useful in a health overview.
            const nowH = Date.now()
            const roster = canonicalSessionRows(nowH).map((session) => ({
              name: session.name,
              role: session.role,
              pid: session.pid,
              transportPids: session.transportPids,
              cwd: session.cwd,
              uptimeMs: session.uptimeMs,
              idleMs: session.idleMs,
              lifecycle: session.lifecycle,
            }))
            return makeResponse(id, {
              ...health,
              machine,
              sessions: roster,
              daemon: {
                pid: process.pid,
                uptime: Math.floor((Date.now() - socket.startedAt) / 1000),
                clients: clients.size,
              },
            })
          }

          // A one-shot CLI cannot own persistent membership. The historical
          // register -> tribe.join -> close sequence created a disposable
          // cli-join-* member, announced it fleet-wide, and immediately
          // announced it left. Checkpoint the native holder instead; provider
          // adapters remain the only membership authority.
          case "cli_join": {
            const name = typeof p.name === "string" ? p.name.trim() : ""
            if (name.length === 0) {
              return makeResponse(id, {
                joined: false,
                observed: false,
                error: "join requires a non-empty persistent persona name",
              })
            }
            const holders = canonicalSessionRows(Date.now()).filter((session) => session.name === name)
            if (holders.length === 0) {
              return makeResponse(id, {
                joined: false,
                observed: false,
                error:
                  `one-shot CLI cannot establish persistent membership for ${name}; ` +
                  "submit a native Tribe join to the live provider pane",
              })
            }
            if (holders.length !== 1) {
              return makeResponse(id, {
                joined: false,
                observed: false,
                error: `contradictory live membership for ${name}: ${holders.length} logical holders`,
              })
            }
            const holder = holders[0]!
            const row = db.prepare("SELECT delivery FROM sessions WHERE id = ?").get(holder.id) as {
              delivery: string
            } | null
            if (!row) {
              throw new Error(
                `live holder ${name} has no durable session row; restart that provider session before retrying tribe join`,
              )
            }
            return makeResponse(id, {
              joined: true,
              observed: true,
              name: holder.name,
              role: holder.role,
              domains: holder.domains,
              delivery: row.delivery,
              memberId: holder.id,
              transportPids: holder.transportPids,
            })
          }

          case "cli_log": {
            const limit = Number(p.limit ?? 20)
            const all = p.all === true
            const refPrefix = typeof p.ref_prefix === "string" && p.ref_prefix.length > 0 ? p.ref_prefix : null
            const replyPrefix = typeof p.reply_prefix === "string" && p.reply_prefix.length > 0 ? p.reply_prefix : null
            const filters: string[] = []
            const values: Array<string | number> = []
            if (refPrefix) {
              filters.push("substr(ref, 1, length(?)) = ?")
              values.push(refPrefix, refPrefix)
            }
            if (replyPrefix) {
              filters.push("substr(reply, 1, length(?)) = ?")
              values.push(replyPrefix, replyPrefix)
            }
            const where = filters.length > 0 ? ` WHERE ${filters.join(" OR ")}` : ""
            const limitSql = all ? "" : " LIMIT ?"
            if (!all) values.push(limit)
            // Keep the established cli_log payload stable now that `rowid` is
            // an explicit AUTOINCREMENT column rather than SQLite's hidden
            // alias. The monotonic cursor is exposed only through the bounded
            // structural status API above, not as an accidental log field.
            const rows = db
              .prepare(
                `SELECT id, type, sender, recipient, kind, content, bead_id, ref,
                        ts, delivery, topic, room_id, request, reply, summary
                 FROM messages${where} ORDER BY ts DESC${limitSql}`,
              )
              .all(...values)
            return makeResponse(id, {
              messages: (rows as unknown[]).reverse(),
              query: { all, ref_prefix: refPrefix, reply_prefix: replyPrefix },
            })
          }

          /**
           * Delivery-attention status for any session (default `@chief`).
           * Returns the count + age of actionable DMs the session hasn't
           * drained via tribe.fetch. See
           * @ag/tribe/21626-per-seat-inbox-staleness-alarm.
           */
          case "cli_inbox_status":
          case "cli_inbox_status_by_launch_v1": {
            const target = resolveInboxTarget(
              p,
              method === "cli_inbox_status_by_launch_v1"
                ? { mode: "launch" }
                : { mode: "explicit", defaultSession: "@chief" },
            )
            if ("errorCode" in target) return makeError(id, target.errorCode, target.errorMessage)
            // Round-trip the daemon-authoritative launch tuple so a managed
            // one-shot CLI can register its send connection under the SAME
            // (launch_id, launch_parent_pid) as the live seat and fan in to it
            // (attributed, no takeover) instead of colliding on the persona
            // name. Explicit-mode (`cli_inbox_status`) carries no launch
            // identity, so these stay absent there. Mirrors
            // cli_inbox_delivery_by_launch_v1's response shape.
            return makeResponse(id, {
              ...readInboxStatus(target.sessionName),
              ...(target.launchId === undefined ? {} : { launch_id: target.launchId }),
              ...(target.launchParentPid === undefined ? {} : { launch_parent_pid: target.launchParentPid }),
            })
          }

          /**
           * OOB payload half of the declared-await delivery adapter. Status
           * remains structural; only a caller that presents the exact
           * launch-resolved sequence/id pair receives the corresponding
           * still-actionable envelope. This raw daemon method is deliberately
           * absent from MCP tools so a wedged MCP transport is not load-bearing.
           */
          case "cli_inbox_delivery_by_launch_v1": {
            const target = resolveInboxTarget(p, { mode: "launch" })
            if ("errorCode" in target) return makeError(id, target.errorCode, target.errorMessage)
            const messageSeq = p.message_seq
            const messageId = requiredNonEmptyString(p.message_id)
            if (!Number.isSafeInteger(messageSeq) || Number(messageSeq) <= 0 || messageId === null) {
              return makeError(
                id,
                -32602,
                "Inbox delivery requires a positive safe message_seq and non-empty message_id",
              )
            }
            const message = stmts.getActionableAttentionDelivery.get({
              $name: target.sessionName,
              $seq: Number(messageSeq),
              $id: messageId,
            }) as Record<string, unknown> | null
            return makeResponse(id, {
              session: target.sessionName,
              launch_id: target.launchId,
              launch_parent_pid: target.launchParentPid,
              message,
            })
          }

          /**
           * Canonical self-mailbox read for a one-shot CLI. The bearer maps to
           * one persisted session; no caller-supplied name, launch id, or pid
           * participates in target selection. Once authenticated, dispatch
           * enters the same tribe.fetch handler used by MCP.
           */
          case "cli_self_inbox_v1": {
            if (
              ["session", "name", "launch_id", "launch_parent_pid", "pid"].some((key) =>
                Object.prototype.hasOwnProperty.call(p, key),
              )
            ) {
              return makeError(
                id,
                -32602,
                "Self inbox derives its mailbox from authority; target overrides are forbidden",
              )
            }
            const outcome = await dispatchAuthenticatedSessionCapability(
              p.authority,
              { kind: "inbox-ack", limit: p.limit, peek: p.peek === true },
              connId,
            )
            if (!("result" in outcome)) {
              return makeError(id, outcome.errorCode, outcome.errorMessage, outcome.errorData)
            }
            return makeResponse(id, outcome.result)
          }

          /**
           * Authenticated one-shot pending close. `owner` selects the
           * recipient-owned row; it never selects caller identity. The bearer
           * resolves the caller context, then the canonical pending handler
           * performs the one close implementation shared with MCP.
           */
          case "cli_session_pending_close_v1": {
            if (
              ["session", "name", "launch_id", "launch_parent_pid", "pid", "prune", "stale_ms", "all", "expired"].some(
                (key) => Object.prototype.hasOwnProperty.call(p, key),
              )
            ) {
              return makeError(
                id,
                -32602,
                "Pending close derives caller identity from authority; identity and non-close operation overrides are forbidden",
              )
            }
            const owner = requiredNonEmptyString(p.owner)
            const close =
              typeof p.close === "string"
                ? p.close
                : Array.isArray(p.close) && p.close.every((value): value is string => typeof value === "string")
                  ? p.close
                  : null
            if (owner === null || close === null) {
              return makeError(id, -32602, "Authenticated pending close requires owner and close")
            }
            const outcome = await dispatchAuthenticatedSessionCapability(
              p.authority,
              { kind: "pending-close", owner, close },
              connId,
            )
            if (!("result" in outcome)) {
              return makeError(id, outcome.errorCode, outcome.errorMessage, outcome.errorData)
            }
            return makeResponse(id, outcome.result)
          }

          /**
           * Bounded actionable drain. An authenticated client may mutate only
           * its own mailbox and may not self-assert a `session` target. A
           * separately configured operator capability may either select a
           * mailbox explicitly or correlate a one-shot CLI to the daemon's
           * persisted launch authority. Correlation never authenticates the
           * caller by itself, and the CLI never registers a transient member.
           */
          case "cli_inbox_drain":
          case "cli_inbox_drain_by_launch_v1": {
            const client = clients.get(connId)
            const authenticatedName =
              client && client.role !== "pending" && client.role !== "watch" ? client.name : null
            const operatorVerdict = operatorCapabilityVerdict(p.operator_capability)
            const operatorAuthorized = operatorVerdict === "authorized"
            if (!operatorAuthorized && !authenticatedName) {
              if (operatorVerdict === "unconfigured") {
                // A refusal that does not name a working path is how a seat
                // concludes its inbox is empty. Four seats lost hours to this
                // one on 2026-08-13, each reading the refusal as "nothing to
                // read" rather than "you cannot read THIS WAY".
                return makeError(
                  id,
                  -32004,
                  "could-not-evaluate inbox drain authority: an operator capability is not configured. " +
                    "This is inherited at launch and cannot be configured now — it will fail every time for this session. " +
                    "YOUR MAIL IS NOT EMPTY, you are not reading it. Working read: `tribe inbox --json` " +
                    "projects your session's canonical attention and advances its cursor. " +
                    "Do NOT substitute `tribe log --limit 10` — it is fleet-wide history with no attention projection and reaches back under a minute.",
                  { kind: "could-not-evaluate", reason: "operator-capability-unconfigured" },
                )
              }
              return makeError(id, -32003, "unauthenticated inbox drain: the operator capability was rejected", {
                kind: "unauthenticated",
                reason: "operator-capability-rejected",
              })
            }
            if (
              !operatorAuthorized &&
              ["session", "launch_id", "launch_parent_pid", "launch_parent_pids"].some((key) =>
                Object.prototype.hasOwnProperty.call(p, key),
              )
            ) {
              return makeError(
                id,
                -32003,
                `Inbox drain is bound to the authenticated current session ${authenticatedName}; session override or launch target override is forbidden`,
              )
            }
            let sessionName = authenticatedName ?? ""
            if (operatorAuthorized) {
              const target = resolveInboxTarget(
                p,
                method === "cli_inbox_drain_by_launch_v1"
                  ? { mode: "launch" }
                  : { mode: "explicit", defaultSession: DEFAULT_INBOX_WAIT_SESSION },
              )
              if ("errorCode" in target) return makeError(id, target.errorCode, target.errorMessage)
              sessionName = target.sessionName
            }
            const requestedLimit = Number(p.limit ?? 10)
            const limit = Number.isFinite(requestedLimit) ? Math.min(100, Math.max(1, Math.trunc(requestedLimit))) : 10
            const tail = stmts.getMessageTailSeq.get() as { seq: number } | null
            const rows = stmts.selectUnackedAttention.all({
              $name: sessionName,
              $upto: tail?.seq ?? 0,
              $limit: limit,
            }) as FetchRow[]
            const last = rows.at(-1)
            if (last && p.peek !== true) {
              stmts.advanceMailboxCursor.run({ $recipient: sessionName, $seq: last.rowid, $now: Date.now() })
            }
            return makeResponse(id, {
              ...readInboxStatus(sessionName),
              drained_count: rows.length,
              events: rows.map(fetchEvent),
            })
          }

          case "cli_inbox_wait":
          case "cli_inbox_wait_by_launch_v1": {
            const target = resolveInboxTarget(
              p,
              method === "cli_inbox_wait_by_launch_v1"
                ? { mode: "launch" }
                : { mode: "explicit", defaultSession: DEFAULT_INBOX_WAIT_SESSION },
            )
            if ("errorCode" in target) return makeError(id, target.errorCode, target.errorMessage)
            const { timeoutMs, wakeOnCorrelatedReply } = resolveInboxWaitOptions(p)
            const sessionName = target.sessionName
            const afterSeqRaw = p.after_seq
            if (afterSeqRaw !== undefined && (!Number.isSafeInteger(afterSeqRaw) || Number(afterSeqRaw) < 0)) {
              return makeError(id, -32602, "Inbox wait after_seq must be a non-negative safe integer")
            }
            const result = await inboxWait.wait(sessionName, connId, timeoutMs, {
              wakeOnCorrelatedReply,
              ...(afterSeqRaw === undefined ? {} : { afterSeq: Number(afterSeqRaw) }),
            })
            // The launch-correlated form proves which managed mailbox is
            // reading. The explicit operator form observes another mailbox
            // and must never forge that seat's receipt.
            if (method === "cli_inbox_wait_by_launch_v1") {
              stmts.touchMailboxAttentionRead.run({ $recipient: sessionName, $now: Date.now() })
            }
            return makeResponse(id, result)
          }

          case "tribe.inbox.wait": {
            const client = clients.get(connId)
            const {
              session: sessionName,
              timeoutMs,
              wakeOnCorrelatedReply,
            } = resolveInboxWaitOptions(p, {
              defaultSession: client?.name ?? DEFAULT_INBOX_WAIT_SESSION,
            })
            const result = await inboxWait.wait(sessionName, connId, timeoutMs, { wakeOnCorrelatedReply })
            if (client?.role === "member") {
              // Attribute the read to the authenticated caller, never to an
              // explicit target supplied in params.
              stmts.touchMailboxAttentionRead.run({ $recipient: client.name, $now: Date.now() })
            }
            const publicResult: Record<string, unknown> = { ...result }
            delete publicResult.baseline_seq
            return makeResponse(id, publicResult)
          }

          /**
           * Layer 3 — andon-pull alarm set. Anyone (user via CLI, agent via
           * tribe.send wrapper) can invoke. Stores reason + author in the
           * coordination table under a fixed key. The chief-drain-check.sh
           * PreToolUse hook reads it and hard-blocks chief tool calls until
           * `cli_alarm_ack` clears it.
           */
          case "cli_alarm_set": {
            const reason = String(p.reason ?? "(no reason given)")
            const by = String(p.by ?? "anonymous")
            const value = JSON.stringify({ reason, by, ts: Date.now() })
            db.prepare(
              "INSERT OR REPLACE INTO coordination (project_id, key, value, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)",
            ).run("", "alarm.active", value, by, Date.now())
            return makeResponse(id, { ok: true, reason, by })
          }

          /** Layer 3 — read current alarm state (or {active:false}). */
          case "cli_alarm_get": {
            const row = db
              .prepare("SELECT value FROM coordination WHERE project_id = ? AND key = ?")
              .get("", "alarm.active") as { value: string | null } | undefined
            if (!row?.value) {
              return makeResponse(id, { active: false })
            }
            try {
              const parsed = JSON.parse(row.value) as { reason: string; by: string; ts: number }
              return makeResponse(id, {
                active: true,
                reason: parsed.reason,
                by: parsed.by,
                ts: parsed.ts,
                age_min: Math.floor((Date.now() - parsed.ts) / 60_000),
              })
            } catch {
              return makeResponse(id, { active: false })
            }
          }

          /** Layer 3 — clear the alarm. Caller is expected to have already
           *  sent a verdict-typed acknowledgement to @user describing the
           *  action taken (the CLI surfaces this as `tribe alarm-ack`). */
          case "cli_alarm_ack": {
            db.prepare("DELETE FROM coordination WHERE project_id = ? AND key = ?").run("", "alarm.active")
            return makeResponse(id, { ok: true })
          }

          case "cli_daemon": {
            return makeResponse(id, {
              pid: process.pid,
              uptime: Math.floor((Date.now() - socket.startedAt) / 1000),
              clients: clients.size,
              dbPath: t.config.dbPath,
              socketPath: socket.socketPath,
              startedAt: socket.startedAt,
              // Wire key kept as `quitTimeout` for external readers; the
              // value is the effective idle-quit delay in seconds.
              quitTimeout: getIdleQuitAfterSec(),
            })
          }

          case "log_event": {
            const client = clients.get(connId)
            const ctx = client?.ctx ?? daemonCtx
            logEvent(
              ctx,
              String(p.type ?? "unknown"),
              p.bead_id as string | undefined,
              p.meta as Record<string, unknown> | undefined,
            )
            if (p.content) logActivity(String(p.type ?? "event"), String(p.content))
            return makeResponse(id, { ok: true })
          }

          case "discover": {
            const query = {
              project_id: p.project_id as string | undefined,
              name: p.name as string | undefined,
            }
            let results = Array.from(clients.values()).filter((c) => c.role !== "pending")
            if (query.project_id) results = results.filter((c) => c.projectId === query.project_id)
            if (query.name) results = results.filter((c) => c.name === query.name)
            return makeResponse(id, {
              results: results.map((c) => ({
                name: c.name,
                role: c.role,
                project: c.project,
                projectId: c.projectId,
                peerSocket: c.peerSocket,
                domains: c.domains,
              })),
            })
          }

          case "set_state": {
            const client = clients.get(connId)
            const projectId = String(p.project_id ?? client?.projectId ?? "")
            const key = String(p.key)
            const value = p.value !== undefined ? JSON.stringify(p.value) : null
            db.prepare(
              "INSERT OR REPLACE INTO coordination (project_id, key, value, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)",
            ).run(projectId, key, value, client?.name ?? "daemon", Date.now())
            return makeResponse(id, { ok: true })
          }

          case "get_state": {
            const client = clients.get(connId)
            const projectId = String(p.project_id ?? client?.projectId ?? "")
            if (p.key) {
              const row = db
                .prepare("SELECT * FROM coordination WHERE project_id = ? AND key = ?")
                .get(projectId, String(p.key))
              return makeResponse(id, { state: row ?? null })
            }
            const rows = db.prepare("SELECT * FROM coordination WHERE project_id = ?").all(projectId)
            return makeResponse(id, { state: rows })
          }

          case "subscribe": {
            return makeResponse(id, { subscribed: true })
          }

          default: {
            if (isRemovedTribeMethod(method)) {
              return makeError(id, -32601, removedTribeMethodMessage(method))
            }

            // Late-bound method handlers (e.g. MCP-spec methods registered
            // by `withMCPServer()`). Checked first so surfaces composed after
            // the dispatcher can answer methods over the same Unix socket.
            const lateHandler = methodHandlers.get(method)
            if (lateHandler) {
              try {
                const result = await lateHandler(p, { connId })
                return makeResponse(id, result as Record<string, unknown>)
              } catch (err) {
                const errorWithCode = err as Error & { code?: number }
                const code = typeof errorWithCode.code === "number" ? errorWithCode.code : -32603
                const msg = errorWithCode.message ?? String(err)
                return makeError(id, code, msg)
              }
            }

            // Lore (memory) RPC surface.
            if (recallHandlers && recallHandlers.isRecallMethod(method)) {
              const client = clients.get(connId)
              const recallConn = client?.recall ?? ({ sessionId: null, claudePid: null } as RecallConnState)
              try {
                const result = await recallHandlers.dispatch(recallConn, method, p)
                return makeResponse(id, result as Record<string, unknown>)
              } catch (err) {
                const errorWithCode = err as Error & { code?: number }
                const code = typeof errorWithCode.code === "number" ? errorWithCode.code : -32603
                const msg = errorWithCode.message ?? String(err)
                return makeError(id, code, msg)
              }
            }
            return makeError(id, -32601, `Method not found: ${method}`)
          }
        }
      } catch (err) {
        if (err instanceof NameConflictError) {
          // Surface the conflict + existing_names + holder_pid so the caller
          // can pick a non-colliding alternative without a separate
          // tribe.sessions query AND verify the holder is a real live
          // process (vs. a stale daemon-side ghost). JSON-RPC error code
          // -32000 = "Server error" (application range).
          log.info?.(
            `NameConflict on ${method}: "${err.desiredName}" taken (existing=${err.existing_names.length}, pid=${err.holder_pid ?? "?"})`,
          )
          return makeError(id, -32000, err.message, {
            existing_names: err.existing_names,
            holder_pid: err.holder_pid,
          })
        }
        const msg = err instanceof Error ? err.message : String(err)
        const failedClient = clients.get(connId)
        log.warn?.("operation.failed", {
          ...connectionLogIdentity(failedClient, connId),
          operation: operationLogName(method),
          error_type: err instanceof Error ? err.name : "NonError",
          error_code: err instanceof Error ? errorCode(err) : "UNKNOWN",
        })
        return makeError(id, -32603, msg)
      }
    }

    function handleConnection(sock: NetSocket): void {
      const connId = randomUUID()
      const pendingName = `pending-${connId}`
      const pendingCtx = createTribeContext({
        db,
        stmts,
        sessionId: connId,
        sessionRole: "pending",
        initialName: pendingName,
        domains: [],
        claudeSessionId: null,
        claudeSessionName: null,
        onMessageInserted,
      })
      log.debug?.("connection.accepted", { connection_id: connId })

      const placeholder: ClientSession = {
        socket: sock,
        id: connId,
        name: pendingName,
        role: "pending",
        domains: [],
        project: process.cwd(),
        projectName: "unknown",
        projectId: "",
        pid: 0,
        launchId: null,
        launchParentPid: null,
        claudeSessionId: null,
        peerSocket: null,
        conn: "",
        ctx: pendingCtx,
        registeredAt: Date.now(),
        lastActivityAt: Date.now(),
        recall: { sessionId: null, claudePid: null },
        protocolVersion: null,
      }
      clients.set(connId, placeholder)
      socketToClient.set(sock, connId)
      onActiveClient()

      const parse = createLineParser(async (msg: JsonRpcMessage) => {
        if (isRequest(msg)) {
          // Slow-method timing lives inside handleRequest so this path and the
          // MCP tools/call path are covered by one implementation.
          const response = await handleRequest(msg, connId)
          try {
            sock.write(response)
          } catch {
            /* socket died during handling */
          }
        }
      })

      sock.on("data", parse)

      sock.on("close", (hadError = false) => {
        const client = clients.get(connId)
        const connectionFields = {
          ...connectionLogIdentity(client, connId),
          reason: hadError ? "socket-error" : "peer-close",
        }
        if (client && client.role !== "pending") {
          const hadChannelJoin = channelJoinAnnounced.delete(connId)
          const siblingTransport = Array.from(clients.values()).some(
            (candidate) => candidate.id !== connId && candidate.ctx.sessionId === client.ctx.sessionId,
          )
          if (hadError && !siblingTransport && client.launchId) {
            broadcast.log(
              `tribe:dispatcher: managed bridge lost after socket error ` +
                `(name=${client.name}, launch=${client.launchId}, parent_pid=${String(client.launchParentPid)})`,
              "health:daemon:warn",
            )
          }
          if (siblingTransport) {
            log.debug?.("transport.disconnected", connectionFields)
          } else {
            log.info?.("session.disconnected", connectionFields)
            // Durable history stays lossless even when the channel projection
            // coalesces a churn storm or suppresses daemon-start noise.
            logEvent(client.ctx, "session.left", undefined, {
              name: client.name,
              role: client.role,
              domains: client.domains,
            })
            const now = Date.now()
            const gateOpen = sessionAnnounceGate(client.name, now)
            if (hadChannelJoin && now - socket.startedAt > suppressWindowMs && gateOpen) {
              logActivity("session", `${client.name} left`)
            }
          }
        } else if (client) {
          log.debug?.("connection.disconnected", connectionFields)
        }
        broadcast.flushConnection(connId)
        broadcast.discardConnection(connId)
        inboxWait.cancelConnection(connId)
        clients.delete(connId)
        socketToClient.delete(sock)
        if (client && client.role !== "pending" && !registry.hasActiveTransport(client.ctx.sessionId)) {
          registry.markTransportDisconnected(client.ctx.sessionId)
        }
        if (recallHandlers && client) recallHandlers.dropConn(client.recall.sessionId)
        if (clients.size === 0) onIdle()
      })

      sock.on("error", (err) => {
        const code = errorCode(err)
        const client = clients.get(connId)
        log.warn?.("connection.error", {
          ...connectionLogIdentity(client, connId),
          reason: "socket-error",
          error_code: code,
          error_type: err.name,
        })
        sock.destroy()
      })
    }

    // Wire the accept handler into the bound server. The withSocketServer
    // factory creates the Server without a handler; we attach via "connection"
    // event listener (Node Server supports late-bound handlers).
    socket.server.on("connection", handleConnection)
    t.scope.defer(() => {
      socket.server.removeListener("connection", handleConnection)
    })

    return {
      ...t,
      dispatcher: {
        handleConnection,
        handleRequest,
        register,
        shutdown: inboxWait.shutdown,
      },
    }
  }
}

type TransportRetirementReason = "self-registration-replaced" | "explicit-takeover" | "identity-displacement"

function operationLogName(value: unknown): string {
  return typeof value === "string" && /^[-A-Za-z0-9._/:$]{1,128}$/.test(value) ? value : "<invalid>"
}

type SessionFilterMode = "focus" | "normal" | "ambient"

function isSessionFilterMode(value: unknown): value is SessionFilterMode {
  return value === "focus" || value === "normal" || value === "ambient"
}

function applyLaunchDeclaredFilter(ctx: TribeContext, mode: SessionFilterMode): void {
  ctx.stmts.setSessionFilter.run({
    $id: ctx.sessionId,
    $mode: mode,
    $until: null,
    $mute: null,
    $now: Date.now(),
  })
}
