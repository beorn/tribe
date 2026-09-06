/**
 * withClientRegistry — owns the in-memory map of connected clients.
 *
 * The registry is a plain Map<connId, ClientSession> on the daemon value. Three
 * surfaces consume it:
 *   - the dispatcher (route requests by connId, look up client.ctx)
 *   - the broadcaster (fan messages to every connected socket)
 *   - the idle-quit (when registry is empty, start the countdown)
 *
 * The tribe-wire daemon is role-agnostic (F12 of
 * @km/tribe/15496-coordination-drift): there is no chief/member distinction
 * and nothing to derive. The only filtering the registry does is by
 * connection-lifecycle tag — `daemon` / `watch` / `pending` sessions are not
 * "participating members" for the active-session helpers.
 *
 * This split exists so the imperative socket / dispatch / idle-quit layers can
 * all read/write the same backing state through one shape, instead of via
 * module-level `const clients = new Map(...)` declarations.
 */

import type { Socket as NetSocket } from "node:net"
import type { RecallConnState } from "../recall-handlers.ts"
import type { TribeContext } from "../context.ts"
import type { TribeRole } from "tribe-wire/lib/config"
import type { BaseTribe } from "./base.ts"

/** The default wire reconnect loop lasts about 4.5 minutes before exhaustion;
 * five minutes covers that contract plus normal registration overhead. */
export const DEFAULT_RECONNECT_GRACE_MS = 5 * 60 * 1000

/** A session participates as a regular tribe member iff it is not the daemon
 *  itself, a read-only watcher, or a half-registered pending connection. */
function isParticipant(c: { role: TribeRole }): boolean {
  return c.role === "member"
}

export type ClientSession = {
  socket: NetSocket
  id: string
  name: string
  role: TribeRole
  domains: string[]
  project: string
  projectName: string
  projectId: string
  pid: number
  /** Provider-launch identity. Null keeps legacy one-transport semantics. */
  launchId: string | null
  /** Launcher PID provenance; paired with launchId to reject stale inheritance. */
  launchParentPid: number | null
  /** Set by the socket-level `leave` method when the adapter announces WHY it
   *  is about to close (its harness exited). Read once, by the disconnect
   *  handler, into the `session.left` fact's `reason`. Absent means the
   *  socket closed with no announcement: `transport-closed`. */
  leaveReason?: "harness-exited"
  claudeSessionId: string | null
  /** Peer socket path for direct proxy-to-proxy connections */
  peerSocket: string | null
  /** Connection path (socket or db) */
  conn: string
  ctx: TribeContext
  registeredAt: number
  /** Wall-clock ms at the last dispatched method from this client. Touched
   *  in `with-dispatcher.ts` for every inbound request; consumers compute
   *  `idleMs = Date.now() - lastActivityAt`. Initialised to `registeredAt`
   *  on connection so a brand-new session reads as 0ms idle. Spec:
   *  `@km/tribe/15588-tribe-list-sessions`. */
  lastActivityAt: number
  /** Per-connection recall state — tracks sessionId/claudePid for recall handlers
   *  (set on tribe.hello / tribe.session_register). Kept separate from the
   *  tribe-side sessionId because a single proxy connection may carry both
   *  coordination + memory traffic interleaved. */
  recall: RecallConnState
  /** Wire version negotiated for this transport; null before registration. */
  protocolVersion?: number | null
}

export interface ClientRegistry {
  /** connId → session */
  readonly clients: Map<string, ClientSession>
  /** socket → connId — reverse index for socket-keyed cleanup */
  readonly socketToClient: Map<NetSocket, string>
  /** ctx.sessionIds of every currently-connected participating member. */
  getActiveSessionIds(): Set<string>
  getActiveSessionInfo(): Array<{
    id: string
    name: string
    pid: number
    cwd: string
    role: TribeRole
    claudeSessionId: string | null
    registeredAt: number
    launchId: string | null
    launchParentPid: number | null
    transportPids: number[]
    protocolVersions?: number[]
  }>
  /** True for any authenticated, fully registered transport, including watch
   * connections. This is broader than participating-member projection. */
  hasActiveTransport(sessionId: string): boolean
  /** Clear disconnect grace once any sibling transport registers. */
  markTransportConnected(sessionId: string): void
  /** Start a fresh grace window after the last sibling transport closes. */
  markTransportDisconnected(sessionId: string, nowMs?: number): void
  /**
   * Observe transport death. `withRuntime` installs the collector here so a
   * registration is retired by the same lifecycle that created it, instead of
   * waiting for the six-hour sweep to notice. The registry stays DB-free: it
   * reports the event and the listener owns the policy.
   */
  onTransportDisconnected(listener: (sessionId: string, nowMs: number) => void): void
  /** Protect startup adoption and bounded reconnect attempts from row reaping. */
  isReconnectGraceProtected(sessionId: string, nowMs: number): boolean
  /** Delay the first automatic reap until daemon-start adoption grace expires. */
  startupReconnectGraceRemainingMs(nowMs: number): number
  /** Forget transient grace entries once their durable rows are reaped. */
  forgetTransportSessions(sessionIds: readonly string[]): void
}

export interface WithClientRegistry {
  readonly registry: ClientRegistry
}

export function withClientRegistry<T extends BaseTribe>(): (t: T) => T & WithClientRegistry {
  return (t) => {
    const clients = new Map<string, ClientSession>()
    const socketToClient = new Map<NetSocket, string>()
    const disconnectedAtBySession = new Map<string, number>()
    const transportDisconnectListeners: Array<(sessionId: string, nowMs: number) => void> = []

    const registry: ClientRegistry = {
      clients,
      socketToClient,
      getActiveSessionIds(): Set<string> {
        const ids = new Set<string>()
        for (const c of clients.values()) {
          if (!isParticipant(c)) continue
          ids.add(c.ctx.sessionId)
        }
        return ids
      },
      getActiveSessionInfo() {
        const members = new Map<
          string,
          {
            id: string
            name: string
            pid: number
            cwd: string
            role: TribeRole
            claudeSessionId: string | null
            registeredAt: number
            launchId: string | null
            launchParentPid: number | null
            transportPids: number[]
            protocolVersions: number[]
          }
        >()
        for (const client of clients.values()) {
          if (!isParticipant(client)) continue
          const id = client.ctx.sessionId
          const member = members.get(id)
          if (member) {
            if (client.pid > 0 && !member.transportPids.includes(client.pid)) member.transportPids.push(client.pid)
            if (
              typeof client.protocolVersion === "number" &&
              !member.protocolVersions.includes(client.protocolVersion)
            ) {
              member.protocolVersions.push(client.protocolVersion)
            }
            member.registeredAt = Math.min(member.registeredAt, client.registeredAt)
            continue
          }
          members.set(id, {
            id,
            name: client.name,
            pid: client.pid,
            cwd: client.project,
            role: client.role,
            claudeSessionId: client.claudeSessionId,
            registeredAt: client.registeredAt,
            launchId: client.launchId,
            launchParentPid: client.launchParentPid,
            transportPids: client.pid > 0 ? [client.pid] : [],
            protocolVersions: typeof client.protocolVersion === "number" ? [client.protocolVersion] : [],
          })
        }
        return Array.from(members.values())
      },
      hasActiveTransport(sessionId): boolean {
        for (const client of clients.values()) {
          if (client.role !== "pending" && client.ctx.sessionId === sessionId) return true
        }
        return false
      },
      markTransportConnected(sessionId): void {
        disconnectedAtBySession.delete(sessionId)
      },
      markTransportDisconnected(sessionId, nowMs = Date.now()): void {
        disconnectedAtBySession.set(sessionId, nowMs)
        for (const listener of transportDisconnectListeners) listener(sessionId, nowMs)
      },
      onTransportDisconnected(listener): void {
        transportDisconnectListeners.push(listener)
      },
      isReconnectGraceProtected(sessionId, nowMs): boolean {
        const disconnectedAt = disconnectedAtBySession.get(sessionId) ?? t.startedAt
        return nowMs < disconnectedAt + DEFAULT_RECONNECT_GRACE_MS
      },
      startupReconnectGraceRemainingMs(nowMs): number {
        return Math.max(0, t.startedAt + DEFAULT_RECONNECT_GRACE_MS - nowMs)
      },
      forgetTransportSessions(sessionIds): void {
        for (const sessionId of sessionIds) disconnectedAtBySession.delete(sessionId)
      },
    }

    // Drop all client refs on shutdown so disposal doesn't leave dangling
    // sockets in the maps. Actual socket teardown is the socket-server's job.
    t.scope.defer(() => {
      clients.clear()
      socketToClient.clear()
      disconnectedAtBySession.clear()
    })

    return { ...t, registry }
  }
}
