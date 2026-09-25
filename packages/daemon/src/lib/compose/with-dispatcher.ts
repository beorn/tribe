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
import { isAbsolute } from "node:path"
import { createLogger } from "loggily"
import { DEFAULT_INBOX_WAIT_SESSION, resolveInboxWaitOptions } from "tribe-wire"
import { deriveTribePersonaLaunchIdentity, providerLaunchIdOf } from "tribe-wire/lib/persona-launch-identity"
import { AG_SESSION_AUTH_ENV, hashSelfMailboxAuthority } from "tribe-wire/lib/self-mailbox-authority"
import { HAB_ID_TOKEN_ENV } from "tribe-wire/lib/identity-token"
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
  projectSessionRowTransport,
  readAttentionProjection,
  readUnackedAttentionRows,
  removedTribeMethodMessage,
  TRIBE_COORD_METHODS,
  readSeatTransportFacts,
} from "../handlers.ts"
import { createLifecycleStore } from "../lifecycle-store.ts"
import type { TribePluginHandle } from "../plugin-api.ts"
import { createInboxWaitManager, readInboxWaitWokenBy } from "../inbox-wait.ts"
import { isTerminalSessionLeftReason, logEvent, logSessionLeft, sendMessage } from "../messaging.ts"
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
import type { DeclaredRoster } from "../membership-declared-roster.ts"
import { STARTUP_SHA, TRIBE_SOURCE_ROOT } from "../code-pin.ts"
import { shouldLogSlowRequest } from "../slow-request-log.ts"
import { derivedLaunchPrefixUpperBound } from "../launch-prefix-range.ts"
import {
  displacementRule,
  sessionAuthority,
  type IdentityVerdict,
  type LoadedIdentityVerifier,
  type SessionAuthority,
} from "../identity-verifier.ts"

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
  /** Exact identities explicitly retired by the composing layer. */
  retiredNames?: ReadonlySet<string>
  /** Hab's declared roster (persona name -> "is this seat expected up"
   *  boolean) as it stands now, supplied by the composing layer so a running
   *  daemon follows the pin file (24660). Absent means no declaration —
   *  membership classification runs unchanged. */
  getExpectedMembers?: () => DeclaredRoster | undefined
  /** The composing layer's identity verifier, loaded at boot (25074 3b). Null or absent: no session is verified,
   *  and every registration is served on its bearer or its claimed name. */
  identityVerifier?: LoadedIdentityVerifier | null
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
  /** Seats by transport from tribe.health's membership projection, for the bridge-lost check (25662). */
  seatTransportFacts: () => ReturnType<typeof readSeatTransportFacts>
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
      const { attentionRows, untakenPendingBalls, actionableCount } = readAttentionProjection(daemonCtx, sessionName)
      const oldest = attentionRows[0]
      const latest = attentionRows.at(-1)
      const attentionMessageIds = new Set(attentionRows.map((row) => row.id))
      const oldestTrackedTs = untakenPendingBalls
        .filter((ball) => ball.request_kind !== "incident" && attentionMessageIds.has(ball.message_id))
        .reduce((oldestTs, ball) => Math.min(oldestTs, Date.parse(ball.opened_at)), Number.POSITIVE_INFINITY)
      const unread_count = actionableCount
      const oldestTs = Math.min(oldest?.ts ?? Number.POSITIVE_INFINITY, oldestTrackedTs)
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

    function latestInboxWaitMessage(
      sessionName: string,
      includeCorrelatedReplies: boolean,
      unacknowledgedOnly: boolean,
    ): { rowid: number } | null {
      const params = {
        $name: sessionName,
        $include_correlated_replies: includeCorrelatedReplies ? 1 : 0,
        $unacknowledged_only: unacknowledgedOnly ? 1 : 0,
      }
      const direct = stmts.getLatestInboxWaitMessage.get(params) as { rowid: number } | null
      const tracked = stmts.getLatestTrackedInboxWaitMessage.get({ $name: sessionName }) as {
        rowid: number
      } | null
      if (direct === null) return tracked
      if (tracked === null) return direct
      return direct.rowid >= tracked.rowid ? direct : tracked
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
      | { kind: "pending-read"; expired: boolean; owed: boolean; staleMs?: number }
      | { kind: "pending-close"; owner: string; close: string | string[] }
      | { kind: "pending-prune"; owner: string; staleMs: number }

    type SessionAuthorityResolution =
      | { context: TribeContext; servedBy?: { readonly authority: "bearer"; readonly fault: string } }
      | { errorCode: number; errorMessage: string; errorData: Record<string, unknown> }

    function invalidPendingReadFilter(params: Record<string, unknown>): string | undefined {
      if (params.expired !== undefined && typeof params.expired !== "boolean") {
        return "Authenticated pending read filter 'expired' must be boolean"
      }
      if (params.owed !== undefined && typeof params.owed !== "boolean") {
        return "Authenticated pending read filter 'owed' must be boolean"
      }
      if (
        params.stale_ms !== undefined &&
        (typeof params.stale_ms !== "number" || !Number.isFinite(params.stale_ms) || params.stale_ms < 0)
      ) {
        return "Authenticated pending read filter 'stale_ms' must be a finite non-negative number"
      }
      return undefined
    }

    /**
     * Resolve the launcher-minted bearer exactly once for every authenticated
     * one-shot operation. The capability union above is deliberately closed:
     * extending what this bearer may do requires a new typed member and its
     * own boundary test, never a caller-supplied method name.
     */
    type LaunchAuthorityRow = {
      id: string
      name: string
      principal_class: "agent" | "service"
      launch_id: string | null
      launch_parent_pid: number | null
    }

    /** One authority decision for lookup, fan-in, bearer reads, and attributed
     * operations (including the send transaction that creates a ball).
     * A service CLI transport cannot outlive its service owner's authority.
     * Agents intentionally retain disconnected launch recovery.
     */
    function hasLaunchAuthority(session: LaunchAuthorityRow): boolean {
      if (isTombstonedSessionName(session.name)) return false
      if (session.principal_class === "agent") return true
      if (session.principal_class !== "service") throw new Error(`invalid principal class for ${session.name}`)
      if (!registry.hasActiveTransport(session.id)) return false
      return Array.from(clients.values()).some(
        (client) =>
          client.ctx.sessionId === session.id &&
          client.principalClass === "service" &&
          client.launchId === session.launch_id &&
          client.launchParentPid === session.launch_parent_pid &&
          client.pid === session.launch_parent_pid &&
          !client.socket.destroyed,
      )
    }

    type AuthorityRow = LaunchAuthorityRow & {
      role: TribeRole
      domains: string
      claude_session_id: string | null
      claude_session_name: string | null
    }
    const AUTHORITY_ROW_COLUMNS =
      "id, name, role, domains, principal_class, launch_id, launch_parent_pid, claude_session_id, claude_session_name"

    function rejected(reason: string, message: string): Extract<SessionAuthorityResolution, { errorCode: number }> {
      return { errorCode: -32003, errorMessage: message, errorData: { kind: "unauthenticated", reason } }
    }

    /**
     * 25074 3b — one decision for a one-shot caller's authority, dual-keyed until 3d deletes the bearer: the launch's
     * identity token when the daemon has a verifier, else the launcher-minted bearer. A verified token resolves the
     * session its registration recorded under the token's sid; the verifier already proved the instance live, so a
     * service needs no connected owner transport beside it. A contradicted token, or a verifier fault, refuses; an
     * unreadable token falls back to the bearer, which is its own authority, and says so in the log.
     *
     * Dual-key (@cto §9): a verified token whose sid has no session yet (registered before the verifier, or before its
     * adapter re-registered with the token) falls back to the bearer on the same call. The authority stays the
     * bearer's session, and the token upgrades nothing; a bearer whose session is another name is refused naming both.
     * A verifier fault (an undecided liveness, §8) beside a valid bearer is served by that bearer too, and the answer
     * names the fault (@cto 03cff4b5). On the registered path another seat's bearer is recorded on the holder's session
     * as a foreign transport, and the call answers as the token's seat (@cto 975a22e2). 3d retires all of it.
     */
    async function resolveSessionAuthority(
      value: unknown,
      idToken: unknown,
      connId: string,
    ): Promise<SessionAuthorityResolution> {
      const token = requiredNonEmptyString(idToken)
      const verifier = hooks.identityVerifier
      if (token !== null && verifier) {
        let verdict: IdentityVerdict
        try {
          verdict = await verifier.verify(token)
        } catch (error) {
          const fault = error instanceof Error ? error.message : String(error)
          const supplied = requiredNonEmptyString(value)
          const bearer = supplied === null ? null : resolveBearerAuthority(supplied)
          if (bearer !== null && !("errorCode" in bearer)) {
            log.warn?.(
              `identity verifier ${verifier.path} could not decide a one-shot caller's token (${fault}); ` +
                `served by ${bearer.row.name}'s bearer`,
            )
            const resolution = contextForAuthorityRow(bearer.row)
            return "context" in resolution
              ? {
                  ...resolution,
                  servedBy: { authority: "bearer", fault: `token undecided: ${fault}; served by bearer` },
                }
              : resolution
          }
          log.error?.(`identity verifier ${verifier.path} failed on a one-shot caller's token: ${fault}`)
          return rejected(
            "identity-verifier-fault",
            `current session authority could not be evaluated: the identity verifier failed: ${fault}` +
              (bearer === null ? "" : `; the ${AG_SESSION_AUTH_ENV} beside it did not match a live managed session`),
          )
        }
        if (verdict.result === "contradicted") {
          return rejected(
            "identity-contradicted",
            `current session authority was rejected: the identity token is contradicted: ${verdict.reason}`,
          )
        }
        if (verdict.result === "verified") {
          const row = db
            .prepare(`SELECT ${AUTHORITY_ROW_COLUMNS} FROM sessions WHERE identity_sid = $sid AND name = $name`)
            .get({ $sid: verdict.sid, $name: verdict.actor }) as AuthorityRow | null
          if (row === null || isTombstonedSessionName(row.name)) {
            const supplied = requiredNonEmptyString(value)
            const notRegistered =
              `current session authority was rejected: ${verdict.actor}'s token is verified, but no session registered ` +
              `under its sid ${verdict.sid}; the seat's own adapter registers it`
            if (supplied === null) return rejected("identity-not-registered", notRegistered)
            const bearer = resolveBearerAuthority(supplied)
            if ("errorCode" in bearer) {
              return rejected(
                "identity-not-registered",
                `${notRegistered}, and the ${AG_SESSION_AUTH_ENV} beside it did not match a live managed session`,
              )
            }
            if (bearer.row.name !== verdict.actor) {
              const message =
                `current session authority was rejected: the bearer belongs to ${bearer.row.name}, but the identity token ` +
                `names ${verdict.actor} (sid ${verdict.sid}); a call carries one seat's credentials, never two`
              log.warn?.(message)
              return {
                errorCode: -32003,
                errorMessage: message,
                errorData: {
                  kind: "foreign-identity-transport",
                  transport: { name: verdict.actor, sid: verdict.sid },
                  authority: { name: bearer.row.name, launch_id: bearer.row.launch_id },
                },
              }
            }
            log.info?.(
              `one-shot caller ${verdict.actor}'s token is verified but no session is registered under its sid ` +
                `${verdict.sid}; resolved by its bearer until its adapter registers with the token`,
            )
            return contextForAuthorityRow(bearer.row)
          }
          const supplied = requiredNonEmptyString(value)
          const bearerRow = supplied === null ? null : bearerAuthorityRow(supplied)
          if (bearerRow !== null && bearerRow.name !== row.name) {
            // As the register path records it (24767, and the precedence refusal; @cto 46063770): on the session
            // whose authority the call presented, the bearer's owner, describing the transport that presented it.
            registry.recordForeignIdentityTransport(bearerRow.id, {
              name: row.name,
              launch_id: row.launch_id ?? "(no launch)",
              pid: clients.get(connId)?.pid ?? 0,
              refused_at: new Date().toISOString(),
            })
            log.warn?.(
              `one-shot caller ${row.name}'s verified token arrived beside ${bearerRow.name}'s bearer; ` +
                `answered as ${row.name} and recorded the foreign transport on ${bearerRow.name}'s session`,
            )
          }
          return contextForAuthorityRow(row)
        }
        if (verdict.result === "unreadable") {
          log.warn?.(`one-shot caller's identity token is unreadable (${verdict.reason}); resolving by its bearer`)
        }
      }
      const supplied = requiredNonEmptyString(value)
      if (supplied === null) {
        return {
          errorCode: -32004,
          errorMessage:
            `current session authority is missing; ${HAB_ID_TOKEN_ENV} or ${AG_SESSION_AUTH_ENV} ` +
            "must be inherited from the managed launch",
          errorData: { kind: "could-not-evaluate", reason: "session-authority-missing" },
        }
      }
      const bearer = resolveBearerAuthority(supplied)
      return "errorCode" in bearer ? bearer : contextForAuthorityRow(bearer.row)
    }

    /** The live managed session a bearer names, or the refusal; one lookup for both keys of the dual-key rule. */
    function resolveBearerAuthority(
      supplied: string,
    ): { readonly row: AuthorityRow } | Extract<SessionAuthorityResolution, { errorCode: number }> {
      const row = bearerAuthorityRow(supplied)
      if (row === null || !hasLaunchAuthority(row)) {
        return rejected(
          "session-authority-rejected",
          `current session authority was rejected or revoked; ${AG_SESSION_AUTH_ENV} did not match a live managed session`,
        )
      }
      return { row }
    }

    /** The session a bearer hashes to, live or not. */
    function bearerAuthorityRow(supplied: string): AuthorityRow | null {
      return db
        .prepare(`SELECT ${AUTHORITY_ROW_COLUMNS} FROM sessions WHERE mailbox_authority_hash = $hash`)
        .get({ $hash: hashSelfMailboxAuthority(supplied) }) as AuthorityRow | null
    }

    function contextForAuthorityRow(row: AuthorityRow): SessionAuthorityResolution {
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
      credentials: { readonly authority: unknown; readonly idToken: unknown },
      capability: AuthenticatedSessionCapability,
      connId: string,
    ): Promise<
      | { result: Awaited<ReturnType<typeof handleToolCall>> }
      | { errorCode: number; errorMessage: string; errorData: Record<string, unknown> }
    > {
      const resolution = await resolveSessionAuthority(credentials.authority, credentials.idToken, connId)
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
      // 25074 (@cto 03cff4b5): a bearer that served the call because the token faulted says so in the answer.
      const annotate = <R extends object>(result: R): R =>
        resolution.servedBy === undefined ? result : { ...result, session_authority: resolution.servedBy }
      switch (capability.kind) {
        case "inbox-ack":
          return {
            result: annotate(
              await handleToolCall(
                resolution.context,
                TRIBE_COORD_METHODS.fetch,
                { limit: capability.limit, advance: capability.peek ? false : undefined },
                DAEMON_HANDLER_OPTS,
                connId,
              ),
            ),
          }
        case "pending-read":
          return {
            result: annotate(
              await handleToolCall(
                resolution.context,
                TRIBE_COORD_METHODS.pending,
                {
                  ...(capability.expired ? { expired: true } : {}),
                  ...(capability.owed ? { owed: true } : {}),
                  ...(capability.staleMs === undefined ? {} : { stale_ms: capability.staleMs }),
                },
                DAEMON_HANDLER_OPTS,
                connId,
              ),
            ),
          }
        case "pending-close":
          return {
            result: annotate(
              await handleToolCall(
                resolution.context,
                TRIBE_COORD_METHODS.pending,
                { owner: capability.owner, close: capability.close },
                DAEMON_HANDLER_OPTS,
                connId,
              ),
            ),
          }
        case "pending-prune":
          return {
            result: annotate(
              await handleToolCall(
                resolution.context,
                TRIBE_COORD_METHODS.pending,
                { owner: capability.owner, prune: true, stale_ms: capability.staleMs },
                DAEMON_HANDLER_OPTS,
                connId,
              ),
            ),
          }
        default: {
          const unreachable: never = capability
          throw new Error(`unhandled authenticated session capability: ${JSON.stringify(unreachable)}`)
        }
      }
    }

    type InboxTargetResolution =
      | {
          sessionName: string
          launchId?: string
          launchParentPid?: number
          /** The resolved session row, for a launch-scoped read only. */
          sessionRow?: {
            id: string
            name: string
            updated_at: number
            delivery: string
            mailbox_authority_hash: string | null
            identity_sid: string | null
          }
        }
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
      // A verified session is keyed by its provider launch, `<sid>@<gen>`, whether the caller's environment carries
      // that bare launch id (a seat) or its persona form `<launch>::<persona>` (a hab job's one-shot).
      const verifiedPrefix = `${providerLaunchIdOf(launchId)}@`
      const verifiedPrefixUpper = derivedLaunchPrefixUpperBound(verifiedPrefix)
      if (derivedPrefixUpper === null || verifiedPrefixUpper === null) {
        // Unreachable: launchId is non-empty above, so the prefix is too. A
        // null bound would silently widen or void the range, so refuse rather
        // than run a query whose result would not mean what it claims.
        return { errorCode: -32602, errorMessage: "Managed inbox request requires a non-empty launch_id" }
      }
      const launchSessions = stmts.getSessionsByProviderLaunchId.all({
        $launch_id: launchId,
        $derived_prefix: derivedPrefix,
        $derived_prefix_upper: derivedPrefixUpper,
        $verified_prefix: verifiedPrefix,
        $verified_prefix_upper: verifiedPrefixUpper,
      }) as Array<
        LaunchAuthorityRow & {
          updated_at: number
          delivery: string
          mailbox_authority_hash: string | null
          identity_sid: string | null
        }
      >
      const routableLaunchSessions = launchSessions.filter(hasLaunchAuthority)
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
                ((session.launch_id === launchId || session.launch_id?.startsWith(verifiedPrefix) === true) &&
                  session.name === persona),
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
      if (launchSession.launch_id === null) {
        return { errorCode: -32003, errorMessage: "Inbox launch identity has no authoritative launch id" }
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
        sessionRow: {
          id: launchSession.id,
          name: launchSession.name,
          updated_at: launchSession.updated_at,
          delivery: launchSession.delivery,
          mailbox_authority_hash: launchSession.mailbox_authority_hash,
          identity_sid: launchSession.identity_sid,
        },
      }
    }

    const inboxWait = createInboxWaitManager(
      readInboxStatus,
      (sessionName) => readAttentionProjection(daemonCtx, sessionName).attention,
      (sessionName, wakeOnCorrelatedReply) => {
        const latest = latestInboxWaitMessage(sessionName, wakeOnCorrelatedReply, false)
        return latest?.rowid ?? 0
      },
      (sessionName, wakeOnCorrelatedReply) => {
        const current = latestInboxWaitMessage(sessionName, wakeOnCorrelatedReply, true)
        return current?.rowid ?? 0
      },
      (sessionName, seq, wakeOnCorrelatedReply) => readInboxWaitWokenBy(stmts, sessionName, seq, wakeOnCorrelatedReply),
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
      getForeignIdentityTransport: (sessionId: string) => registry.getForeignIdentityTransport(sessionId),
      getLifecycleStore: () => lifecycleStore,
      inboxWait,
      notifyWakeupForReplay,
      reapStaleTransports,
      resolveDelivery: hooks.resolveDelivery,
      retiredNames: hooks.retiredNames,
      getExpectedMembers: hooks.getExpectedMembers,
      recallVaultRefusal: t.config.vaultDbRefusal ?? null,
      identityVerifierPath: hooks.identityVerifier?.path ?? null,
      identityVerifierSuppliesGen: hooks.identityVerifier ? hooks.identityVerifier.suppliesGen : null,
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

    type RegistrationRefusal = { readonly message: string; readonly data: Record<string, unknown> }

    /** 25074 3b — verify a register's identity token through the composing layer's verifier. The sid is null when
     *  the session is served on its bearer or its claimed name: no token, no verifier, or a token the verifier could
     *  not read. A token that is contradicted, names another actor, or makes the verifier fail refuses. */
    async function verifyRegistrationIdentity(
      token: string | null,
      requestedName: unknown,
    ): Promise<
      { readonly sid: string | null; readonly gen: number | null } | { readonly refusal: RegistrationRefusal }
    > {
      const verifier = hooks.identityVerifier
      if (token === null || !verifier) return { sid: null, gen: null }
      const claimed = typeof requestedName === "string" ? requestedName : "(no name)"
      let verdict: IdentityVerdict
      try {
        verdict = await verifier.verify(token)
      } catch (error) {
        const fault = error instanceof Error ? error.message : String(error)
        log.error?.(`identity verifier ${verifier.path} failed on the token ${claimed} presented: ${fault}`)
        return {
          refusal: {
            message: `register refused: the identity verifier failed on the token ${claimed} presented: ${fault}`,
            data: { kind: "identity-verifier-fault", verifier: verifier.path },
          },
        }
      }
      switch (verdict.result) {
        case "verified":
          if (verdict.actor === requestedName) return { sid: verdict.sid, gen: verdict.gen ?? null }
          return {
            refusal: {
              message: `register refused: this transport claims ${claimed}, but its identity token names ${verdict.actor}`,
              data: { kind: "identity-name-mismatch", claimed, actor: verdict.actor },
            },
          }
        case "contradicted":
          return {
            refusal: {
              message: `register refused: the identity token ${claimed} presented is contradicted: ${verdict.reason}`,
              data: { kind: "identity-contradicted", claimed, reason: verdict.reason },
            },
          }
        case "unreadable":
          log.warn?.(`register: ${claimed}'s identity token is unreadable (${verdict.reason}); not verified`)
          return { sid: null, gen: null }
        case "absent":
          return { sid: null, gen: null }
      }
    }

    function holderIdentity(sessionId: string): {
      authority: SessionAuthority
      token: string | null
      sid: string | null
      gen: number | null
    } {
      const row = db
        .prepare(
          "SELECT identity_sid, mailbox_authority_hash, verified_id_token, identity_gen FROM sessions WHERE id = ?",
        )
        .get(sessionId) as {
        identity_sid: string | null
        mailbox_authority_hash: string | null
        verified_id_token: string | null
        identity_gen: number | null
      } | null
      return row === null
        ? { authority: "claimed", token: null, sid: null, gen: null }
        : {
            authority: sessionAuthority(row),
            token: row.verified_id_token,
            sid: row.identity_sid,
            gen: row.identity_gen,
          }
    }

    /** A verified holder's liveness, asked by re-verifying the token it registered with (25074 3c, @cto §10):
     *  "live" refuses a bearer displacement, "gone" allows it, and a fault (undecided, or nothing to ask with)
     *  refuses it the way a fault refuses any register, for the claimant to retry. */
    async function verifiedHolderLiveness(token: string | null): Promise<"live" | "gone" | { readonly fault: string }> {
      const verifier = hooks.identityVerifier
      if (token === null) return { fault: "the holder's verified token is not on record" }
      if (!verifier) return { fault: "no identity verifier is loaded" }
      try {
        const verdict = await verifier.verify(token)
        if (verdict.result === "verified") return "live"
        if (verdict.result === "contradicted") return "gone"
        return { fault: `the holder's token now reads ${verdict.result}` }
      } catch (error) {
        return { fault: error instanceof Error ? error.message : String(error) }
      }
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
      tokenSid: string | null = null,
    ): {
      holder: ClientSession
      launch: LaunchIdentity
      transportClass: string
      promotedFrom?: LaunchIdentity
    } | null {
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

        // 25074 3c-2b (@cto def441bf): a token-keyed register fans into its own seat's bootstrap that fell back to
        // bearer under the launch id, whose provider part IS the token's sid, from the same launcher pid. The holder is
        // promoted in place to `<sid>@<gen>`. Another launcher pid is a previous generation and is not fanned into; a
        // verified holder is 3c-2a's fence's to judge.
        if (
          tokenSid !== null &&
          launchIdentity !== null &&
          holderLaunch !== null &&
          providerLaunchIdOf(holderLaunch.id) === tokenSid &&
          holderLaunch.parentPid === launchIdentity.parentPid &&
          holderIdentity(holder.ctx.sessionId).authority !== "verified"
        ) {
          return {
            holder,
            launch: launchIdentity,
            transportClass: "bootstrap-fallback-promoted",
            promotedFrom: holderLaunch,
          }
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

    /**
     * 25074 3c-2b — a bootstrap that fell back to bearer is re-keyed from its launch id to its seat token's
     * `<sid>@<gen>`, guarded on the launch it held, and the promotion is its own journal row so a fallback that was
     * later promoted stays visible (@cto def441bf).
     */
    function rekeyPromotedFallbackLaunch(
      holder: ClientSession,
      from: LaunchIdentity,
      to: LaunchIdentity,
      token: { readonly sid: string; readonly gen: number },
    ): void {
      const result = db
        .prepare(
          // 24604 (a): the stored start time belongs to the old parent pid, so a new pid drops it (pid-only).
          `UPDATE sessions SET launch_id = ?, launch_parent_pid = ?,
             launch_parent_start_time = CASE WHEN launch_parent_pid IS ? THEN launch_parent_start_time ELSE NULL END,
             updated_at = ?
           WHERE id = ? AND launch_id = ? AND launch_parent_pid = ?`,
        )
        .run(to.id, to.parentPid, to.parentPid, Date.now(), holder.ctx.sessionId, from.id, from.parentPid)
      if (result.changes !== 1) {
        throw new Error(`refusing bootstrap-fallback promotion for ${holder.ctx.sessionId}: its launch moved`)
      }
      for (const sibling of clients.values()) {
        if (sibling.ctx.sessionId !== holder.ctx.sessionId) continue
        sibling.launchId = to.id
        sibling.launchParentPid = to.parentPid
      }
      log.info?.(
        `identity promotion: ${holder.name}'s bearer bootstrap (launch ${from.id}) is promoted in place to ${to.id}`,
      )
      logEvent(holder.ctx, "session.identity-promoted", undefined, {
        name: holder.name,
        session_id: holder.ctx.sessionId,
        sid: token.sid,
        gen: token.gen,
        parent_pid: to.parentPid,
        from_launch_id: from.id,
        transport_class: "bootstrap-fallback-promoted",
      })
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
        principalClass: "agent" | "service"
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
        principalClass: fields.principalClass,
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
        if (
          method !== "register" &&
          liveClient?.launchId &&
          !hasLaunchAuthority({
            id: liveClient.ctx.sessionId,
            name: liveClient.name,
            principal_class: liveClient.principalClass ?? "agent",
            launch_id: liveClient.launchId,
            launch_parent_pid: liveClient.launchParentPid,
          })
        ) {
          return makeError(
            id,
            -32003,
            `launch authority for ${liveClient.name} is unavailable; its service owner is disconnected`,
          )
        }
        switch (method) {
          case "register": {
            // 24604 (a): the holders this registration displaced by its own authority (takeover, identity precedence,
            // same-pid replacement). registerSession may replace their rows; any other live durable launch keeps its name.
            const displacedSessionIds = new Set<string>()
            const displaceClient = (client: ClientSession, reason: TransportRetirementReason): void => {
              displacedSessionIds.add(client.ctx.sessionId)
              retireReplacedClient(client, reason)
            }
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
            const adapterExitRecord =
              typeof p.adapterExitRecord === "string" && isAbsolute(p.adapterExitRecord) ? p.adapterExitRecord : null
            if (p.adapterExitRecord !== undefined && adapterExitRecord === null) {
              return makeError(id, -32602, "register adapterExitRecord must be an absolute file path")
            }
            if (p.principalClass !== undefined && p.principalClass !== "agent" && p.principalClass !== "service") {
              return makeError(id, -32602, "register principalClass must be agent or service")
            }
            if (p.idToken !== undefined && (typeof p.idToken !== "string" || p.idToken.length === 0)) {
              return makeError(
                id,
                -32602,
                "register idToken must be a non-empty string; omit it when the launch has none",
              )
            }
            const identity = await verifyRegistrationIdentity(typeof p.idToken === "string" ? p.idToken : null, p.name)
            // A verifier fault stays a refusal whatever launch id the register carries (@cto ab05bc5c): the adapter
            // retries until its token verifies (P2-A), and a bootstrap has 3c-1's client-side fallback.
            if ("refusal" in identity) {
              log.warn?.(identity.refusal.message)
              return makeError(id, -32003, identity.refusal.message, identity.refusal.data)
            }
            const verifiedSid = identity.sid
            const verifiedGen = identity.gen
            const hasLaunchId = p.launchId !== undefined && p.launchId !== null
            // The token itself is kept beside the sid so a later bearer registration can ask whether this holder's
            // instance is still live before displacing it (displacementRule's "holder-liveness").
            const verifiedToken = verifiedSid === null ? null : (p.idToken as string)
            const claimantAuthority: SessionAuthority =
              verifiedSid !== null ? "verified" : mailboxAuthorityHash !== null ? "bearer" : "claimed"
            const hasLaunchParentPid = p.launchParentPid !== undefined && p.launchParentPid !== null
            // 25074 3c-2b forward fix (@cto 95c2be2d (a)): a verified token keys the session `<sid>@<gen>` whether or not
            // the client also sent its launch id, and a launch id it did send must be that token's seat: its provider
            // part is the token's sid, or the register is refused by name. A verdict without gen keys by the launch id
            // it was sent (3c-2a), and with none it cannot key the session and refuses by name.
            if (hasLaunchId && verifiedSid !== null && providerLaunchIdOf(String(p.launchId).trim()) !== verifiedSid) {
              const message =
                `register refused: ${String(p.name)}'s token verifies as sid ${verifiedSid}, ` +
                `but it was sent with launch ${String(p.launchId)}, which belongs to another launch`
              log.warn?.(message)
              return makeError(id, -32003, message, {
                kind: "identity-mismatch",
                claimed: p.name,
                launch_id: String(p.launchId),
                sid: verifiedSid,
              })
            }
            const tokenKeyed = verifiedSid !== null && (verifiedGen !== null || !hasLaunchId)
            if (tokenKeyed && verifiedGen === null) {
              const message =
                `register refused: ${String(p.name)}'s token verified, but the verifier verdict carries no gen; ` +
                "the daemon cannot key this session without a launch id"
              log.warn?.(message)
              return makeError(id, -32003, message, { kind: "identity-verdict-without-gen", claimed: p.name })
            }
            if (tokenKeyed ? !hasLaunchParentPid : hasLaunchId !== hasLaunchParentPid) {
              return makeError(
                id,
                -32602,
                tokenKeyed
                  ? "a register keyed by its identity token still requires launchParentPid"
                  : "register requires launchId and launchParentPid together; omit both for legacy transport registration",
              )
            }
            const launchIdRaw = tokenKeyed
              ? `${verifiedSid}@${verifiedGen}`
              : typeof p.launchId === "string"
                ? p.launchId.trim()
                : ""
            const launchParentPidRaw = Number(p.launchParentPid ?? 0)
            const launchIdentityValid =
              launchIdRaw.length > 0 && Number.isSafeInteger(launchParentPidRaw) && launchParentPidRaw > 0
            if ((hasLaunchId || tokenKeyed) && !launchIdentityValid) {
              return makeError(
                id,
                -32602,
                "register launch identity requires a non-empty launchId and positive integer launchParentPid; omit both for legacy transport registration",
              )
            }
            // Only complete absence selects legacy per-transport semantics.
            const launchIdentity = launchIdentityValid ? { id: launchIdRaw, parentPid: launchParentPidRaw } : null

            // 24767 — a session authority is minted per provider launch. A
            // transport presenting one under a different provider launch was
            // started with another seat's identity (a shared provider config
            // baked it), so it can never become that seat. Refuse it naming both
            // identities; the unique authority index used to surface this as a
            // bare "name taken" and the adapter retried forever.
            // A token-keyed register has proven its identity; a bearer minted under the seat's pre-3c-2b launch id is
            // no evidence against it.
            if (mailboxAuthorityHash !== null && launchIdentity !== null && !tokenKeyed) {
              const authorityHolder = db
                .prepare("SELECT id, name, launch_id FROM sessions WHERE mailbox_authority_hash = ?")
                .get(mailboxAuthorityHash) as { id: string; name: string; launch_id: string | null } | null
              if (
                authorityHolder?.launch_id != null &&
                providerLaunchIdOf(authorityHolder.launch_id) !== providerLaunchIdOf(launchIdentity.id)
              ) {
                const claimedName = typeof p.name === "string" ? p.name : "(no name)"
                registry.recordForeignIdentityTransport(authorityHolder.id, {
                  name: claimedName,
                  launch_id: launchIdentity.id,
                  pid: Number(p.pid ?? 0),
                  refused_at: new Date().toISOString(),
                })
                const message =
                  `register refused: this transport claims ${claimedName} on launch ${launchIdentity.id}, ` +
                  `but its session authority belongs to ${authorityHolder.name} on launch ${authorityHolder.launch_id}. ` +
                  "It was started with another seat's identity; restart this MCP connector from its own seat's launch environment."
                log.warn?.(message)
                return makeError(id, -32003, message, {
                  kind: "foreign-identity-transport",
                  transport: { name: claimedName, launch_id: launchIdentity.id },
                  authority: { name: authorityHolder.name, launch_id: authorityHolder.launch_id },
                })
              }
            }

            const isServiceOwner =
              p.principalClass === "service" && launchIdentity !== null && Number(p.pid) === launchIdentity.parentPid
            if (p.principalClass === "service" && !isServiceOwner) {
              return makeError(id, -32602, "a service owner must register its own pid as launchParentPid")
            }

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
            // Class belongs to the resolved identity, not the optional caller
            // name. PID/cwd adoption and persisted renames must not turn an
            // expired service into an agent with disconnected recovery rights.
            const priorServices = db
              .prepare(
                `SELECT id, name, principal_class, launch_id, launch_parent_pid FROM sessions
               WHERE principal_class = 'service' AND
                 (name = ? OR id = ? OR (launch_id = ? AND launch_parent_pid = ?))`,
              )
              .all(
                resolvedName,
                adopted?.id ?? null,
                launchIdentity?.id ?? null,
                launchIdentity?.parentPid ?? null,
              ) as LaunchAuthorityRow[]
            if (priorServices.length > 0 && p.principalClass === "agent") {
              return makeError(id, -32602, "register cannot change a service launch into an agent launch")
            }
            const principalClass = p.principalClass === "service" || priorServices.length > 0 ? "service" : "agent"
            if (principalClass === "service" && !isServiceOwner) {
              const authorized = priorServices.some(
                (prior) =>
                  prior.launch_id === launchIdentity?.id &&
                  prior.launch_parent_pid === launchIdentity?.parentPid &&
                  hasLaunchAuthority(prior),
              )
              if (!authorized) {
                return makeError(
                  id,
                  -32003,
                  `launch authority for ${resolvedName} is unavailable; its service owner is disconnected or the current launch tuple was not supplied`,
                )
              }
            }
            const launchFanIn = findLaunchFanIn(
              resolvedName,
              clientPid,
              launchIdentity,
              connId,
              tokenKeyed ? verifiedSid : null,
            )
            if (launchFanIn) {
              const { holder, launch, transportClass, promotedFrom } = launchFanIn
              // Backfill the durable one-shot fence when multiple transports
              // from a launch fan in before any cross-launch contention.
              if (p.takeover === true && typeof p.name === "string") {
                claimLaunchTakeover(resolvedName, launch, connId)
              }
              if (promotedFrom === undefined) {
                promoteSessionLaunchIdentity(holder.ctx.sessionId, launch, identityToken)
              } else {
                // findLaunchFanIn promotes only for a token-keyed register, which carries both.
                rekeyPromotedFallbackLaunch(holder, promotedFrom, launch, {
                  sid: verifiedSid as string,
                  gen: verifiedGen as number,
                })
              }
              if (verifiedSid !== null) {
                db.prepare(
                  "UPDATE sessions SET identity_sid = ?, verified_id_token = ?, identity_gen = ? WHERE id = ?",
                ).run(verifiedSid, verifiedToken, verifiedGen, holder.ctx.sessionId)
              }
              if (filterMode !== undefined) applyLaunchDeclaredFilter(holder.ctx, filterMode)
              const client = applyClient(connId, {
                name: holder.name,
                role: holder.role,
                domains: holder.domains,
                principalClass: holder.principalClass ?? "agent",
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
                // 25074 3c-2b (@cto b58e4715): the launch identity this register was keyed under, which the client
                // certifies its members row against; for a token register only the daemon knows it (`<sid>@<gen>`).
                launchId: client.launchId,
                launchParentPid: client.launchParentPid,
                name: client.name,
                role: client.role,
                principalClass: client.principalClass,
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
              displaceClient(samePidHolder, "self-registration-replaced")
            }

            // 25074 3b/3c — authority precedence on a name (displacementRule, @cto §10). A registration the rule bars
            // from displacing a connected holder (takeover, or 21052's token displacement, below) is refused as a
            // foreign identity (24767), and the holder's session and inbox are untouched. A bearer registration
            // displaces a verified holder only when that holder's instance is gone; an undecided holder refuses it as
            // a fault the claimant retries. A verified registration displaces a holder that only claimed the name, and
            // the holder's journal says why.
            const precedenceRefusal = async (holder: ClientSession): Promise<string | null> => {
              const held = holderIdentity(holder.ctx.sessionId)
              const { authority: holderAuthority, token } = held
              // 25074 3c-2a — the fence is generation-aware between two verified instances of one session: a higher
              // gen is the successor's takeover (the holder is told), a lower one is stale and refused by name.
              // The same gen fanned in above; reaching here with it is a second instance claiming one generation.
              if (
                claimantAuthority === "verified" &&
                holderAuthority === "verified" &&
                held.sid === verifiedSid &&
                held.gen !== null &&
                verifiedGen !== null &&
                verifiedGen <= held.gen
              ) {
                const stale = verifiedGen < held.gen
                registry.recordForeignIdentityTransport(holder.ctx.sessionId, {
                  name: resolvedName,
                  launch_id: launchIdentity?.id ?? "(no launch)",
                  pid: clientPid,
                  refused_at: new Date().toISOString(),
                })
                const message = stale
                  ? `register refused: ${resolvedName} generation ${verifiedGen} is older than the live ` +
                    `holder's generation ${held.gen} (pid ${holder.pid}); a stale instance never displaces its successor`
                  : `register refused: ${resolvedName} generation ${verifiedGen} is already held by a live instance ` +
                    `(pid ${holder.pid}) under another launch parent`
                log.warn?.(message)
                return makeError(id, -32003, message, {
                  kind: "foreign-identity-transport",
                  reason: stale ? "identity-generation-stale" : "identity-generation-duplicate",
                  transport: { name: resolvedName, gen: verifiedGen },
                  holder: { name: holder.name, gen: held.gen },
                })
              }
              const rule = displacementRule(holderAuthority, claimantAuthority)
              if (rule === "allowed") return null
              if (rule === "holder-liveness") {
                const liveness = await verifiedHolderLiveness(token)
                if (liveness === "gone") return null
                if (liveness !== "live") {
                  const message =
                    `register refused: ${resolvedName}'s verified holder (pid ${holder.pid}) can be judged neither ` +
                    `live nor gone right now (${liveness.fault}); retry`
                  log.warn?.(message)
                  return makeError(id, -32003, message, {
                    kind: "identity-verifier-fault",
                    reason: "holder-liveness-undecided",
                    holder: { name: holder.name, authority: holderAuthority },
                  })
                }
              }
              registry.recordForeignIdentityTransport(holder.ctx.sessionId, {
                name: resolvedName,
                launch_id: launchIdentity?.id ?? "(no launch)",
                pid: clientPid,
                refused_at: new Date().toISOString(),
              })
              const message =
                `register refused: this transport claims ${resolvedName} with ${claimantAuthority} authority, ` +
                `but a live ${holderAuthority} session holds it (pid ${holder.pid}), and it never displaces a live ` +
                "session that outranks it; start this transport from the seat's own managed launch."
              log.warn?.(message)
              return makeError(id, -32003, message, {
                kind: "foreign-identity-transport",
                reason: "identity-precedence",
                transport: { name: resolvedName, authority: claimantAuthority },
                holder: { name: holder.name, authority: holderAuthority },
              })
            }
            if (claimantAuthority === "verified") {
              for (const holder of Array.from(clients.values())) {
                if (holder.id === connId || holder.name !== resolvedName) continue
                if (holderIdentity(holder.ctx.sessionId).authority !== "claimed") continue
                log.warn?.(
                  `identity displacement: a verified registration supersedes the claimed holder of "${resolvedName}" (old pid ${holder.pid}, old session ${holder.ctx.sessionId}, new pid ${clientPid})`,
                )
                logEvent(holder.ctx, "session.superseded", undefined, {
                  name: resolvedName,
                  old_pid: holder.pid,
                  new_pid: clientPid,
                  reason: "a verified identity displaced a claimed holder (25074)",
                })
                displaceClient(holder, "identity-displacement")
              }
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
                for (const displaced of holders) {
                  const refusal = await precedenceRefusal(displaced)
                  if (refusal !== null) return refusal
                }
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
                for (const replaced of holders) displaceClient(replaced, "explicit-takeover")
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
                  const refusal = await precedenceRefusal(holder)
                  if (refusal !== null) return refusal
                  log.warn?.(
                    `identity displacement: superseding token-less holder of "${resolvedName}" (old pid ${holder.pid}, old session ${holder.ctx.sessionId}, new pid ${clientPid})`,
                  )
                  logEvent(holder.ctx, "session.superseded", undefined, {
                    name: resolvedName,
                    old_pid: holder.pid,
                    new_pid: clientPid,
                    reason: "identity displacement of token-less holder (21052)",
                  })
                  displaceClient(holder, "identity-displacement")
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
            // 25688 (@cto 7b5b85c7): a token-less register that adopts a verified row of its OWN launch (same launch id,
            // same parent) is that launch reconnecting, so the row keeps its verification. Read before registerSession
            // restates the row; any other token-less register still reads as unverified.
            const ownLaunchVerification =
              verifiedSid === null && launchIdentity !== null
                ? (db
                    .prepare(
                      `SELECT identity_sid, verified_id_token, identity_gen FROM sessions
                       WHERE id = ? AND launch_id = ? AND launch_parent_pid = ? AND identity_sid IS NOT NULL`,
                    )
                    .get(clientCtx.sessionId, launchIdentity.id, launchIdentity.parentPid) as {
                    identity_sid: string
                    verified_id_token: string | null
                    identity_gen: number | null
                  } | null)
                : null
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
              displacedSessionIds,
              verifiedSid !== null && verifiedGen !== null ? { sid: verifiedSid, gen: verifiedGen } : null,
            )
            db.prepare("UPDATE sessions SET principal_class = ? WHERE id = ?").run(principalClass, clientCtx.sessionId)
            // Every register restates the session's verification: an adopted session re-registering without a token
            // it can verify is no longer served as verified, unless it is its own launch reconnecting (25688).
            const restated = ownLaunchVerification ?? {
              identity_sid: verifiedSid,
              verified_id_token: verifiedToken,
              identity_gen: verifiedSid === null ? null : verifiedGen,
            }
            db.prepare(
              "UPDATE sessions SET identity_sid = ?, verified_id_token = ?, identity_gen = ? WHERE id = ?",
            ).run(restated.identity_sid, restated.verified_id_token, restated.identity_gen, clientCtx.sessionId)
            // G9 P0 row 7 — the launch's adapter-exit record, named by the plugin
            // supervisor that appends to it. Omission keeps a reconnecting
            // session's stored path, as it does for account and provider.
            if (adapterExitRecord !== null) {
              db.prepare("UPDATE sessions SET adapter_exit_record = ? WHERE id = ?").run(
                adapterExitRecord,
                clientCtx.sessionId,
              )
            }
            // Apply launch-declared admission before applyClient makes this
            // session visible to the broadcast fanout. Omission preserves a
            // reconnecting session's stored preference; an explicit mode is
            // authoritative and clears stale time/topic dimensions.
            if (filterMode !== undefined) applyLaunchDeclaredFilter(clientCtx, filterMode)

            const client = applyClient(connId, {
              name,
              role,
              domains,
              principalClass,
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
              // 25074 3c-2b (@cto b58e4715): the launch identity this register was keyed under (null for a legacy
              // per-transport register), which the client certifies its members row against.
              launchId: client.launchId,
              launchParentPid: client.launchParentPid,
              name,
              role,
              principalClass,
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
            // 25663 P3 (@cto bf0417a0): the list a reloading adapter ranks itself in. The declared roster is the same
            // for every adapter whenever it reads; sessions[] holds only those rejoined so far.
            const declared = [...(hooks.getExpectedMembers?.()?.byName.keys() ?? [])].sort()
            const declaredSet = new Set(declared)
            const liveUndeclared = [...new Set(sessions.map((session) => session.name))]
              .filter((name) => !declaredSet.has(name))
              .sort()
            return makeResponse(id, {
              sessions,
              reload_peers: { declared, live_undeclared: liveUndeclared },
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
            const { getBridgeLostArming, getHealthSampleStats, getHealthSnapshot } =
              await import("../health-monitor-plugin.ts")
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
              // 25662: doctor prints "bridge-lost paging disarmed: <reason>" from this; never a silent default.
              bridge_lost: getBridgeLostArming(),
              // 24248: skipped health-sample ticks ride the rail; null means the monitor has not started.
              health_sample: getHealthSampleStats() ?? null,
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
            const holder = holders[0]
            if (holder === undefined) throw new Error(`live membership for ${name} disappeared during registration`)
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
            let rows = db
              .prepare(
                `SELECT id, type, sender, recipient, kind, content, bead_id, ref,
                        ts, delivery, topic, room_id, request, reply, summary
                 FROM messages${where} ORDER BY ts DESC${limitSql}`,
              )
              .all(...values) as Array<{ id: string; ts: number }>
            if (refPrefix) {
              const receipts = stmts.getOpenRequestStatusesForRefPrefix.all({
                $prefix: refPrefix,
                $limit: all ? -1 : limit,
              }) as Array<{ id: string; ts: number }>
              // Each subset's newest N is sufficient for the combined newest
              // N. A hot receipt can occur in both queries; return it once.
              rows = [...new Map([...rows, ...receipts].map((row) => [row.id, row])).values()].sort(
                (a, b) => b.ts - a.ts,
              )
              if (!all && limit >= 0) rows = rows.slice(0, limit)
            }
            return makeResponse(id, {
              messages: rows.reverse(),
              query: { all, ref_prefix: refPrefix, reply_prefix: replyPrefix },
            })
          }

          /**
           * Delivery-attention status for any session (default `@chief`).
           * Returns the count + age of unread attention messages and open
           * balls without an owner TAKING receipt. See
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
            // G9 P0 row 7: a seat's tribe adapter can die while the seat keeps
            // working through one-shot CLI calls like this one, so a launch-scoped
            // read names the caller's own transport when it is not connected,
            // through the projection tribe members uses. A connected seat's
            // response is unchanged.
            const selfTransport =
              target.sessionRow === undefined
                ? undefined
                : projectSessionRowTransport(
                    target.sessionRow,
                    registry.getActiveSessionIds(),
                    registry.getActiveSessionInfo(),
                    { stmts, hasLiveWaiter: inboxWait.hasLiveWaiter },
                    registry.getForeignIdentityTransport(target.sessionRow.id),
                  ).evidence
            // Round-trip the daemon-authoritative launch tuple so a managed
            // one-shot CLI can register its send connection under the SAME
            // (launch_id, launch_parent_pid) as the live seat and fan in to it
            // (attributed, no takeover) instead of colliding on the persona
            // name. Explicit-mode (`cli_inbox_status`) carries no launch
            // identity, so these stay absent there. Mirrors
            // cli_inbox_delivery_by_launch_v1's response shape.
            return makeResponse(id, {
              ...readInboxStatus(target.sessionName),
              ...(stmts.getOpenRequestStatus.get({ $name: target.sessionName }) as {
                open_request_status_count: number | null
                /** Latest retained status for current open requests; not a cursor.
                 * May decrease when a request settles. */
                latest_open_request_status_seq: number | null
              }),
              ...(target.launchId === undefined ? {} : { launch_id: target.launchId }),
              ...(target.launchParentPid === undefined ? {} : { launch_parent_pid: target.launchParentPid }),
              ...(selfTransport === undefined || selfTransport.transport_state === "connected"
                ? {}
                : {
                    transport_state: selfTransport.transport_state,
                    transport_reason: selfTransport.transport_reason,
                  }),
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
            const params = {
              $name: target.sessionName,
              $seq: Number(messageSeq),
              $id: messageId,
            }
            const message =
              (stmts.getActionableAttentionDelivery.get(params) as Record<string, unknown> | null) ??
              (stmts.getTrackedAttentionDelivery.get(params) as Record<string, unknown> | null)
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
              { authority: p.authority, idToken: p.idToken },
              { kind: "inbox-ack", limit: p.limit, peek: p.peek === true },
              connId,
            )
            if (!("result" in outcome)) {
              return makeError(id, outcome.errorCode, outcome.errorMessage, outcome.errorData)
            }
            return makeResponse(id, outcome.result)
          }

          /**
           * Authenticated current-session pending read for a one-shot CLI.
           * The bearer resolves the owner context; caller-supplied identity
           * selectors are forbidden, then the canonical pending handler owns
           * filtering, expiry folding, and the response shape.
           */
          case "cli_session_pending_read_v1": {
            if (
              ["session", "name", "launch_id", "launch_parent_pid", "pid", "owner", "all", "close", "prune"].some(
                (key) => Object.prototype.hasOwnProperty.call(p, key),
              )
            ) {
              return makeError(
                id,
                -32602,
                "Pending read derives owner identity from authority; owner override is forbidden",
              )
            }
            const invalidFilter = invalidPendingReadFilter(p)
            if (invalidFilter !== undefined) return makeError(id, -32602, invalidFilter)
            const outcome = await dispatchAuthenticatedSessionCapability(
              { authority: p.authority, idToken: p.idToken },
              {
                kind: "pending-read",
                expired: p.expired === true,
                owed: p.owed === true,
                ...(typeof p.stale_ms === "number" ? { staleMs: p.stale_ms } : {}),
              },
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
              { authority: p.authority, idToken: p.idToken },
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
            const tail = stmts.getAttentionTailSeq.get() as { seq: number } | null
            const rows = readUnackedAttentionRows(daemonCtx, sessionName, tail?.seq ?? 0, limit)
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
              // Consumer evidence follows the receipt rule below (24664).
              consumesMailbox: method === "cli_inbox_wait_by_launch_v1",
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
            const result = await inboxWait.wait(sessionName, connId, timeoutMs, {
              wakeOnCorrelatedReply,
              // Only the caller waiting on its own mailbox consumes it (24664).
              consumesMailbox: client?.role === "member" && client.name === sessionName,
            })
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

          // The adapter's one word before it closes: its stdin ended, so the
          // harness process is gone and this launch is over. Recorded on the
          // connection and written into the `session.left` fact by the
          // disconnect handler. A socket that closes without this word — a
          // signal, a crash, a daemon restart — stays `transport-closed`, which
          // the membership projection treats as no evidence at all
          // (@ag/tribe/tribe-membership-projection-counts-permanent-history-as-degraded).
          case "leave": {
            const client = clients.get(connId)
            if (!client) return makeResponse(id, { error: "leave: connection is not registered" })
            if (!isTerminalSessionLeftReason(p.reason)) {
              return makeResponse(id, {
                error: `leave: unknown reason ${JSON.stringify(p.reason)}; expected "harness-exited"`,
              })
            }
            client.leaveReason = p.reason
            return makeResponse(id, { ok: true, reason: p.reason })
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

      const parse = createLineParser((msg: JsonRpcMessage) => {
        if (!isRequest(msg)) return
        // Slow-method timing covers this path and the MCP tools/call path.
        void handleRequest(msg, connId)
          .then((response) => {
            return sock.destroyed ? undefined : sock.write(response)
          })
          .catch((error: unknown) => {
            log.error?.(`request ${msg.method} failed on connection ${connId}`, { error })
            sock.destroy()
          })
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
            // coalesces a churn storm or suppresses daemon-start noise. Carries
            // launch identity + `ref = member_id` so the membership projection
            // can tell a launch that ENDED from one that only lost transport
            // (@ag/tribe/tribe-membership-projection-counts-permanent-history-as-degraded).
            logSessionLeft(client.ctx, {
              memberId: client.ctx.sessionId,
              name: client.name,
              role: client.role,
              domains: client.domains,
              launchId: client.launchId,
              launchParentPid: client.launchParentPid,
              reason: client.leaveReason ?? "transport-closed",
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
        seatTransportFacts: () => readSeatTransportFacts(daemonCtx, DAEMON_HANDLER_OPTS),
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
