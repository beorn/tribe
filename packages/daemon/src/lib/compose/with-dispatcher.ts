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
 *   - `getCliDaemonExtras()` / `getCliStatusExtras()` — late-bound
 *     introspection that needs runtime knobs (quitTimeout, etc.).
 *   - `suppressWindowMs` — join/leave broadcast window after hot-reload.
 *
 * The dispatcher attaches its connection handler to the bound `socket.server`
 * via `server.on("connection", handler)`.
 */

import { randomUUID } from "node:crypto"
import { type Socket as NetSocket } from "node:net"
import { createLogger } from "loggily"
import { DEFAULT_INBOX_WAIT_SESSION, resolveInboxWaitOptions } from "tribe-wire"
import {
  createLineParser,
  isRequest,
  makeError,
  makeResponse,
  TRIBE_PROTOCOL_VERSION,
  type JsonRpcMessage,
  type JsonRpcRequest,
} from "tribe-wire/lib/socket"
import { detectRole, resolveProjectId, type TribeRole } from "tribe-wire/lib/config"
import { createTribeContext, type MessageInsertedInfo, type TribeContext } from "../context.ts"
import {
  fetchEvent,
  handleToolCall,
  isRemovedTribeMethod,
  removedTribeMethodMessage,
  TRIBE_COORD_METHODS,
  type FetchRow,
} from "../handlers.ts"
import { createLifecycleStore } from "../lifecycle-store.ts"
import { createInboxWaitManager } from "../inbox-wait.ts"
import { logEvent, sendMessage } from "../messaging.ts"
import { registerSession, NameConflictError } from "../session.ts"
import { adoptByPidCwd, adoptIdentity, resolveName, type PriorSession } from "../resolve-name.ts"
import { type RecallConnState } from "../recall-handlers.ts"
import type { BaseTribe } from "./base.ts"
import type { WithBroadcast } from "./with-broadcast.ts"
import type { WithClientRegistry, ClientSession } from "./with-client-registry.ts"
import type { WithConfig } from "./with-config.ts"
import type { WithDaemonContext } from "./with-daemon-context.ts"
import type { WithDatabase } from "./with-database.ts"
import type { WithRecall } from "./with-recall.ts"
import type { WithSocketServer } from "./with-socket-server.ts"

const log = createLogger("tribe:dispatcher")

export interface DispatcherRuntimeHooks {
  /** Called from accept(). Default: no-op. Wire to withIdleQuit. */
  onActiveClient?: () => void
  /** Called when the registry empties on disconnect. */
  onIdle?: () => void
  /** Plugin names surfaced via cli_status. Default: empty array. */
  getActivePluginNames?: () => string[]
  /** Quit-timeout (seconds) returned by cli_daemon. Default: -1. */
  getQuitTimeoutSec?: () => number
  /** Suppress-window for join/leave broadcasts. Default: 10000ms (0 disables). */
  suppressWindowMs?: number
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
    const getQuitTimeoutSec = hooks.getQuitTimeoutSec ?? (() => -1)
    const suppressWindowMs = hooks.suppressWindowMs ?? (process.env.TRIBE_NO_SUPPRESS ? 0 : 10_000)
    const sessionAnnounceGate = createSessionAnnounceGate(suppressWindowMs)
    const channelJoinAnnounced = new Set<string>()

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
    } {
      const row = stmts.getUnreadDms.get({ $name: sessionName }) as { count: number; oldest_ts: number } | undefined
      const unread_count = row?.count ?? 0
      const oldest_ts = row?.oldest_ts ?? 0
      const oldest_unread_age_min = oldest_ts > 0 ? Math.floor((Date.now() - oldest_ts) / 60_000) : 0
      return {
        session: sessionName,
        unread_count,
        oldest_unread_age_min,
        oldest_unread_ts: oldest_ts,
      }
    }

    const inboxWait = createInboxWaitManager(readInboxStatus)
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
        }
      })
    }

    /**
     * Actionable-recovery nudge (19442) — when handleJoin / handleRename
     * detects unacknowledged actionable directs waiting in the claimed name's
     * durable mailbox, fire an MCP `wakeup` notification at the claiming
     * session's live socket so push-mode clients drain immediately instead of
     * waiting for the next turn-start `tribe.fetch` (whose default drain
     * injects + acknowledges the recovered actionables). Pull-mode clients
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

    /** No-op handler opts for daemon-side tool calls. */
    const DAEMON_HANDLER_OPTS = {
      cleanup: () => {},
      userRenamed: false,
      setUserRenamed: () => {},
      getActiveSessionIds: () => registry.getActiveSessionIds(),
      getActiveSessionInfo: () => registry.getActiveSessionInfo(),
      getLifecycleStore: () => lifecycleStore,
      inboxWait,
      notifyWakeupForReplay,
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

    /** Generate a unique member-<pid> name, with random suffix if taken */
    function generateMemberName(pid: number, connId: string): string {
      const pidName = `member-${pid || connId.slice(0, 6)}`
      const taken = db.prepare("SELECT id FROM sessions WHERE name = ?").get(pidName)
      return taken ? `member-${pid}-${Math.random().toString(36).slice(2, 5)}` : pidName
    }
    void generateMemberName // currently unused but kept for parity

    function deduplicateName(name: string): string {
      const live = Array.from(clients.values())
      const holder = live.find((c) => c.name === name)
      if (!holder) return name
      // No silent fallback. Surface the conflict so the caller picks a fresh
      // name explicitly. The list of taken names + the live PID of the holder
      // go on the error so the caller doesn't need a separate
      // tribe.sessions round-trip AND can verify the conflict is real
      // (`isPidAlive(holder_pid)` on the caller side).
      const connectedNames = live.map((c) => c.name).sort()
      throw new NameConflictError(name, connectedNames, holder.pid || null)
    }

    function findSamePidNameHolder(name: string, clientPid: number, connId: string): ClientSession | null {
      if (!clientPid || clientPid <= 0) return null
      return Array.from(clients.values()).find((c) => c.id !== connId && c.name === name && c.pid === clientPid) ?? null
    }

    function retireReplacedClient(client: ClientSession): void {
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
      },
    ): ClientSession {
      const existing = clients.get(connId)!
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

    async function handleRequest(req: JsonRpcRequest, connId: string): Promise<string> {
      const { method, params, id } = req
      const p = (params ?? {}) as Record<string, unknown>

      // Touch lastActivityAt for THIS client on every inbound request —
      // drives the idle column in `tribe sessions` / `tribe health`.
      // Spec: @km/tribe/15588-tribe-list-sessions.
      const liveClient = clients.get(connId)
      if (liveClient) liveClient.lastActivityAt = Date.now()

      try {
        switch (method) {
          case "register": {
            const claudeSessionName = (p.claudeSessionName as string) ?? null
            const claudeSessionId = (p.claudeSessionId as string) ?? null
            const identityToken = (p.identityToken as string) ?? null
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
            const resolvedName = resolveName({
              db,
              p: pForResolve,
              adopted,
              claudeSessionName,
              claudeSessionId,
              role,
              isActive,
              projectId,
              takenNames,
              clientPid,
            })
            const launch = launchIdentity
            const sameLaunchHolder = launch
              ? (Array.from(clients.values()).find(
                  (client) =>
                    client.id !== connId &&
                    client.name === resolvedName &&
                    client.launchId === launch.id &&
                    client.launchParentPid === launch.parentPid,
                ) ?? null)
              : null
            if (sameLaunchHolder && launch) {
              const client = applyClient(connId, {
                name: sameLaunchHolder.name,
                role: sameLaunchHolder.role,
                domains: sameLaunchHolder.domains,
                project,
                projectName,
                projectId,
                pid: clientPid,
                launchId: launch.id,
                launchParentPid: launch.parentPid,
                claudeSessionId,
                peerSocket,
                ctx: sameLaunchHolder.ctx,
              })
              log.info?.(
                `launch fan-in: ${resolvedName} member=${client.ctx.sessionId} transport pid=${clientPid} launch=${launch.id}`,
              )
              const coordState = db
                .prepare("SELECT key, value FROM coordination WHERE project_id = ?")
                .all(projectId) as Array<{ key: string; value: string | null }>
              return makeResponse(id, {
                sessionId: client.ctx.sessionId,
                name: client.name,
                role: client.role,
                protocolVersion: TRIBE_PROTOCOL_VERSION,
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
              retireReplacedClient(samePidHolder)
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
              const holders = Array.from(clients.values()).filter(
                (client) => client.id !== connId && client.name === resolvedName,
              )
              const holder = holders[0]
              if (holder) {
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
                for (const replaced of holders) retireReplacedClient(replaced)
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
                  retireReplacedClient(holder)
                }
              }
            }

            const name = deduplicateName(resolvedName)
            const pid = Number(p.pid ?? 0)

            const clientProtocolVersion = p.protocolVersion ? Number(p.protocolVersion) : undefined
            if (clientProtocolVersion !== undefined && clientProtocolVersion !== TRIBE_PROTOCOL_VERSION) {
              log.info?.(
                `Protocol version mismatch: client=${clientProtocolVersion}, daemon=${TRIBE_PROTOCOL_VERSION} (session=${name})`,
              )
            }

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
              (sid) => registry.getActiveSessionIds().has(sid),
              identityToken,
              pid,
              delivery,
              project,
              account,
              provider,
              launchIdentity?.id ?? null,
              launchIdentity?.parentPid ?? null,
            )

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
            })

            resetOffsetsToTail(client)
            announceJoin(client)

            const coordState = db
              .prepare("SELECT key, value FROM coordination WHERE project_id = ?")
              .all(projectId) as Array<{ key: string; value: string | null }>

            return makeResponse(id, {
              sessionId: clientCtx.sessionId,
              name,
              role,
              protocolVersion: TRIBE_PROTOCOL_VERSION,
              coordinationState: coordState,
              daemon: { pid: process.pid, uptime: Math.floor((Date.now() - socket.startedAt) / 1000) },
            })
          }

          case TRIBE_COORD_METHODS.send:
          case TRIBE_COORD_METHODS.fetch:
          case TRIBE_COORD_METHODS.members:
          case TRIBE_COORD_METHODS.rename:
          case TRIBE_COORD_METHODS.join:
          case TRIBE_COORD_METHODS.health:
          case TRIBE_COORD_METHODS.reload:
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
            const result = await handleToolCall(ctx, method, p, DAEMON_HANDLER_OPTS)
            if ((method === TRIBE_COORD_METHODS.join || method === TRIBE_COORD_METHODS.rename) && client) {
              client.name = ctx.getName()
              client.role = ctx.getRole()
            }
            return makeResponse(id, result)
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

          case "cli_log": {
            const limit = Number(p.limit ?? 20)
            const rows = db.prepare("SELECT * FROM messages ORDER BY ts DESC LIMIT ?").all(limit)
            return makeResponse(id, { messages: (rows as unknown[]).reverse() })
          }

          /**
           * Chief-silent watchdog Layer 2 — inbox status for any session
           * (default `@chief`). Returns the count + age of actionable DMs
           * the session hasn't drained via tribe.fetch.
           * See @km/all/silent-errors-enforcement/chief-silent-watchdog-relay-pattern-detection.
           */
          case "cli_inbox_status": {
            const sessionName = String(p.session ?? "@chief")
            return makeResponse(id, readInboxStatus(sessionName))
          }

          /**
           * Bounded, name-keyed actionable drain for long-lived hosts whose
           * current tool bridge cannot expose `tribe.fetch`. This advances the
           * same durable mailbox cursor as fetch without registering, joining,
           * renaming, or otherwise creating a transient session row.
           */
          case "cli_inbox_drain": {
            const sessionName = String(p.session ?? DEFAULT_INBOX_WAIT_SESSION)
            const requestedLimit = Number(p.limit ?? 10)
            const limit = Number.isFinite(requestedLimit) ? Math.min(100, Math.max(1, Math.trunc(requestedLimit))) : 10
            const tail = stmts.getMessageTailSeq.get() as { seq: number } | null
            const rows = stmts.selectUnackedActionables.all({
              $name: sessionName,
              $upto: tail?.seq ?? 0,
              $limit: limit,
            }) as FetchRow[]
            const last = rows.at(-1)
            if (last) {
              stmts.advanceMailboxCursor.run({ $recipient: sessionName, $seq: last.rowid, $now: Date.now() })
            }
            return makeResponse(id, {
              ...readInboxStatus(sessionName),
              drained_count: rows.length,
              events: rows.map(fetchEvent),
            })
          }

          case "cli_inbox_wait": {
            const { session: sessionName, timeoutMs } = resolveInboxWaitOptions(p, {
              defaultSession: DEFAULT_INBOX_WAIT_SESSION,
            })
            return makeResponse(id, await inboxWait.wait(sessionName, connId, timeoutMs))
          }

          case "tribe.inbox.wait": {
            const client = clients.get(connId)
            const { session: sessionName, timeoutMs } = resolveInboxWaitOptions(p, {
              defaultSession: client?.name ?? DEFAULT_INBOX_WAIT_SESSION,
            })
            return makeResponse(id, await inboxWait.wait(sessionName, connId, timeoutMs))
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
            if (!row || !row.value) {
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
              quitTimeout: getQuitTimeoutSec(),
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
        log.info?.(`Error handling ${method}: ${msg}`)
        return makeError(id, -32603, msg)
      }
    }

    function handleConnection(sock: NetSocket): void {
      const connId = randomUUID()
      log.info?.(`Client connected: ${connId.slice(0, 8)}`)

      const placeholder: ClientSession = {
        socket: sock,
        id: connId,
        name: `pending-${connId.slice(0, 6)}`,
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
        ctx: daemonCtx,
        registeredAt: Date.now(),
        lastActivityAt: Date.now(),
        recall: { sessionId: null, claudePid: null },
      }
      clients.set(connId, placeholder)
      socketToClient.set(sock, connId)
      onActiveClient()

      const parse = createLineParser(async (msg: JsonRpcMessage) => {
        if (isRequest(msg)) {
          const response = await handleRequest(msg, connId)
          try {
            sock.write(response)
          } catch {
            /* socket died during handling */
          }
        }
      })

      sock.on("data", parse)

      sock.on("close", () => {
        const client = clients.get(connId)
        if (client && client.role !== "pending") {
          const hadChannelJoin = channelJoinAnnounced.delete(connId)
          const siblingTransport = Array.from(clients.values()).some(
            (candidate) => candidate.id !== connId && candidate.ctx.sessionId === client.ctx.sessionId,
          )
          if (siblingTransport) {
            log.debug?.(`Transport disconnected: ${client.name} pid=${client.pid}`)
          } else {
            log.info?.(`Client disconnected: ${client.name}`)
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
        }
        broadcast.flushConnection(connId)
        broadcast.discardConnection(connId)
        inboxWait.cancelConnection(connId)
        clients.delete(connId)
        socketToClient.delete(sock)
        if (recallHandlers && client) recallHandlers.dropConn(client.recall.sessionId)
        if (clients.size === 0) onIdle()
      })

      sock.on("error", (err) => {
        log.info?.(`Client error (${connId.slice(0, 8)}): ${err.message}`)
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
      dispatcher: { handleConnection, handleRequest, register },
    }
  }
}
