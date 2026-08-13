/**
 * withRuntime — the apply-and-emit loop. Owns plugin lifecycle, the
 * shutdown() entry point, the cleanup tick, and `tribe.run()`.
 *
 * The factory takes:
 *
 *   - `buildPluginApi(t)` — derive the TribeClientApi from the daemon value.
 *     The default api uses the daemon's daemonCtx + registry; tests may
 *     swap a stub.
 *   - `plugins` — observer plugins to load. Filtered by available(); each
 *     active plugin's stop() is collected and called on shutdown.
 *   - `cleanupIntervalMs` (default 6h) — how often `cleanupOldData` runs.
 *
 * Hooks that other phases need to call into the runtime:
 *
 *   - `publishActivePluginNames(names)` — let withDispatcher's cli_status see
 *     the loaded plugin names.
 *   - `publishPluginStatus(handles)` — the same surface, but including plugins
 *     that were skipped or FAILED, so a disabled plugin is a named state in
 *     `tribe status` rather than a silent absence from the names list.
 *   - `publishStopPlugins(fn)` — let withHotReload's re-exec call stop() so
 *     plugin cursors flush.
 *   - `publishShutdown(fn)` — let withSignals + withIdleQuit + withHotReload
 *     trigger graceful shutdown.
 *
 * The `tribe.run()` method exposed in the value resolves when the daemon's
 * scope.signal aborts (shutdown / SIGINT / hot-reload / idle-quit / fatal).
 */

import { createLogger } from "loggily"
import { sendMessage } from "../messaging.ts"
import { cleanupOldData, backfillDefaultRoomMembers, reapStaleTransportRows, activeLaunchIds } from "../session.ts"
import { loadPlugins } from "../plugin-loader.ts"
import type { TribeClientApi, TribePluginApi, TribePluginHandle } from "../plugin-api.ts"
import type { BaseTribe } from "./base.ts"
import type { WithBroadcast } from "./with-broadcast.ts"
import { DEFAULT_RECONNECT_GRACE_MS, type WithClientRegistry } from "./with-client-registry.ts"
import type { WithConfig } from "./with-config.ts"
import type { WithDaemonContext } from "./with-daemon-context.ts"
import type { WithDispatcher } from "./with-dispatcher.ts"
import type { WithDatabase } from "./with-database.ts"
import type { WithRecall } from "./with-recall.ts"
import type { WithSocketServer } from "./with-socket-server.ts"

const log = createLogger("tribe:runtime")

type RuntimeShape = BaseTribe &
  WithConfig &
  WithDatabase &
  WithDaemonContext &
  WithDispatcher &
  WithRecall &
  WithClientRegistry &
  WithBroadcast &
  WithSocketServer

export interface RuntimeOpts<T extends RuntimeShape> {
  /** Build the TribeClientApi the plugins see. Defaults to the canonical impl. */
  buildPluginApi?: (t: T) => TribeClientApi
  /** Plugins to load. Filtered by `available()`. */
  plugins: TribePluginApi[]
  /** Cleanup interval (data retention). Default 6h. */
  cleanupIntervalMs?: number
  /** Bridges to other factories — see file header. */
  publishActivePluginNames: (names: string[]) => void
  /**
   * Full per-plugin outcome, including the ones that failed to load and WHY.
   * Optional so test harnesses composing withRuntime need not care.
   */
  publishPluginStatus?: (handles: TribePluginHandle[]) => void
  publishStopPlugins: (fn: () => void) => void
  publishShutdown: (fn: () => void) => void
}

export interface Runtime {
  /** Resolves when the daemon's scope aborts. */
  run(): Promise<void>
  /** Synchronous shutdown — closes plugins, aborts scope, exits. */
  shutdown(): void
}

export interface WithRuntime {
  readonly runtime: Runtime
  /** Re-exposes `tribe.run()` at the value level for ergonomics. */
  run(): Promise<void>
}

function defaultBuildPluginApi<T extends RuntimeShape>(t: T): TribeClientApi {
  const { stmts, daemonCtx, daemonSessionId, registry } = t
  const { clients } = registry
  return {
    send(recipient, content, type, beadId, classification, incident) {
      sendMessage(
        daemonCtx,
        recipient,
        content,
        type,
        beadId,
        undefined,
        recipient === "*" ? "broadcast" : "direct",
        classification ?? {},
        // A watcher's incident identity reaches the ball tracker here. Absent
        // it, the tracker keys on the message id and every tick is a new
        // obligation — the shape stage 2(d) exists to end.
        incident === undefined ? {} : { incident },
      )
    },
    broadcast(content, type, beadId, classification) {
      sendMessage(daemonCtx, "*", content, type, beadId, undefined, "broadcast", classification ?? {})
    },
    claimDedup(key) {
      const result = stmts.claimDedup.run({ $key: key, $session_id: daemonSessionId, $ts: Date.now() })
      return result.changes > 0
    },
    hasRecentMessage(contentPrefix) {
      const since = Date.now() - 300_000
      return !!stmts.hasRecentMessage.get({ $prefix: contentPrefix, $since: since })
    },
    getActiveSessions() {
      return Array.from(clients.values())
        .filter((c) => c.role !== "watch" && c.role !== "pending")
        .map((c) => ({ name: c.name, pid: c.pid, role: c.role }))
    },
    getSessionNames() {
      return Array.from(clients.values())
        .filter((c) => c.role !== "watch" && c.role !== "pending")
        .map((c) => c.name)
    },
    getUnreadDms(sessionName) {
      const row = stmts.getUnreadDms.get({ $name: sessionName }) as { count: number; oldest_ts: number } | undefined
      return {
        count: row?.count ?? 0,
        oldestTs: row?.oldest_ts ?? 0,
      }
    },
  }
}

export function withRuntime<T extends RuntimeShape>(opts: RuntimeOpts<T>): (t: T) => T & WithRuntime {
  return (t) => {
    const buildPluginApi = opts.buildPluginApi ?? defaultBuildPluginApi
    const cleanupIntervalMs = opts.cleanupIntervalMs ?? 6 * 60 * 60 * 1000

    // Build the api the plugins see, then load.
    const tribeClientApi = buildPluginApi(t)
    const loadedPlugins = loadPlugins(opts.plugins, tribeClientApi)
    const activePluginNames = loadedPlugins.active.filter((p) => p.active).map((p) => p.name)
    const stopPlugins = loadedPlugins.stop

    opts.publishActivePluginNames(activePluginNames)
    opts.publishPluginStatus?.(loadedPlugins.active)
    opts.publishStopPlugins(stopPlugins)

    const reapStaleTransports = (onlySessionIds?: ReadonlySet<string>) => {
      const nowMs = Date.now()
      const report = reapStaleTransportRows(t.db, {
        nowMs,
        hasActiveTransport: (sessionId) => t.registry.hasActiveTransport(sessionId),
        isReconnectGraceProtected: (sessionId) => t.registry.isReconnectGraceProtected(sessionId, nowMs),
        getActiveLaunchIds: () => activeLaunchIds(t.registry.getActiveSessionInfo()),
        onlySessionIds,
      })
      const reapedIds = report.reaped_sessions.map((session) => session.member_id)
      t.registry.forgetTransportSessions(reapedIds)
      if (report.reaped > 0) {
        log.info?.(`cleanup: reaped ${report.reaped} disconnected connection-scoped session row(s)`)
      }
      return report
    }

    // A registration is retired by the lifecycle that created it. Waiting for
    // the six-hour sweep below meant a register/die cycle left its row behind
    // for up to six hours, and only a later registration claiming the SAME
    // NAME evicted it — so anonymous churn, which never collides, accumulated
    // rows unboundedly and every full-table read paid for all of them.
    //
    // Collection is deferred to the end of the reconnect grace rather than run
    // at disconnect: a pull-delivery seat has no socket between polls, and
    // `isReconnectGraceProtected` deliberately protects it. Re-running the one
    // reap policy after the grace expires means a seat that came back is
    // simply still connected and its row is preserved by the existing
    // `hasActiveTransport` fence — no second eviction rule, no new race.
    //
    // Departures are batched behind a SINGLE timer so a churn storm costs one
    // scoped reap rather than one timer and one scan per dead connection. Each
    // pending session keeps its OWN disconnect time, because each one's grace
    // ends at its own expiry, not at the first departure's: batching on one
    // timer armed by the first disconnect and then clearing the whole queue
    // reaps that one session and silently forgets every session that was still
    // inside its own grace when the timer fired — they fall through to the
    // six-hour sweep, which is the behaviour this code exists to replace.
    //
    // So the timer fires, reaps only what has actually expired, leaves the
    // rest queued, and re-arms for the earliest remaining expiry. An empty
    // queue disarms. Later disconnects always expire later than earlier ones,
    // so an armed timer never needs to be moved earlier.
    const REAP_SLACK_MS = 1_000
    const pendingReapAt = new Map<string, number>()
    let reapTimer: ReturnType<typeof setTimeout> | null = null

    const graceExpiryFor = (disconnectedAtMs: number): number =>
      disconnectedAtMs + DEFAULT_RECONNECT_GRACE_MS + REAP_SLACK_MS

    function armReapTimer(nowMs: number): void {
      if (reapTimer !== null || pendingReapAt.size === 0) return
      let earliest = Number.POSITIVE_INFINITY
      for (const disconnectedAt of pendingReapAt.values()) {
        earliest = Math.min(earliest, graceExpiryFor(disconnectedAt))
      }
      reapTimer = setTimeout(collectExpiredRegistrations, Math.max(0, earliest - nowMs))
      ;(reapTimer as { unref?: () => void }).unref?.()
    }

    function collectExpiredRegistrations(): void {
      reapTimer = null
      const nowMs = Date.now()
      const due = new Set<string>()
      for (const [sessionId, disconnectedAt] of pendingReapAt) {
        if (graceExpiryFor(disconnectedAt) <= nowMs) {
          due.add(sessionId)
          pendingReapAt.delete(sessionId)
        }
      }
      if (due.size > 0) reapStaleTransports(due)
      // Whatever is still inside its own grace stays queued and re-arms here,
      // so no departure is ever dropped between fires.
      armReapTimer(Date.now())
    }

    t.registry.onTransportDisconnected((sessionId, nowMs) => {
      pendingReapAt.set(sessionId, nowMs)
      armReapTimer(nowMs)
    })
    t.scope.defer(() => {
      if (reapTimer !== null) clearTimeout(reapTimer)
    })

    // Cleanup tick — registers on root scope so disposal stops it. The normal
    // data-retention cleanup remains eager; stale transports wait for daemon
    // startup reconnect grace, then share this existing six-hour cadence as
    // the backstop for anything the disconnect-driven collection above missed
    // (a daemon that died before its timer fired, rows from an older build).
    const cleanupInterval = setInterval(() => {
      cleanupOldData(t.daemonCtx)
      reapStaleTransports()
    }, cleanupIntervalMs) as unknown as {
      unref?: () => void
    }
    cleanupInterval.unref?.()
    t.scope.defer(() => clearInterval(cleanupInterval as unknown as ReturnType<typeof setInterval>))
    cleanupOldData(t.daemonCtx)
    const startupReapDelayMs = t.registry.startupReconnectGraceRemainingMs(Date.now())
    const startupReapTimer = setTimeout(reapStaleTransports, startupReapDelayMs) as unknown as {
      unref?: () => void
    }
    startupReapTimer.unref?.()
    t.scope.defer(() => clearTimeout(startupReapTimer as unknown as ReturnType<typeof setTimeout>))

    // Matrix-shape invariant (km-tribe.matrix-shape): every row in `sessions`
    // must have a corresponding row in `room_members` for its project's
    // default room. registerSession() satisfies the invariant for new sessions;
    // this backfill catches historic rows from before the invariant existed
    // (DBs that migrated through v10 but haven't yet seen a registerSession on
    // every row) and any code path that bypasses registerSession.
    const backfilled = backfillDefaultRoomMembers(t.daemonCtx)
    if (backfilled > 0) {
      log.info?.(`backfilled ${backfilled} room_members row(s) at startup`)
    }

    let exited = false
    function shutdown(): void {
      if (exited) return
      exited = true
      log.info?.("Shutting down...")
      // GOAWAY before socket teardown lets long-poll clients redial
      // deliberately instead of discovering shutdown through EOF.
      t.dispatcher.shutdown()
      stopPlugins()
      // Close recall explicitly for ordering (the scope.defer in withRecall would
      // catch it too, but we want it before sockets so the focus poller and
      // summarizer don't keep writing as the db closes).
      void t.recall?.close()
      // Close all client sockets cleanly.
      for (const [, client] of t.registry.clients) {
        try {
          client.socket.end()
        } catch {
          /* ignore */
        }
      }
      t.registry.clients.clear()
      // Cascade everything else through scope.dispose. Server.close + socket
      // file unlink + db close + watcher close all live in scope-deferred
      // disposers registered by their factories.
      void t.scope[Symbol.asyncDispose]().catch(() => {})
      // Force-exit hammer WILL fire after 250ms regardless
      // of what scope dispose is doing. The previous `.unref()` here was a
      // bug — an unref'd timer doesn't keep the event loop alive long enough
      // to fire its own callback if every other handle is also unref'd or if
      // a sync-heavy task starves the loop. The donor-daemon zombie pattern
      // tracked at @km/bearly/hot-reload-zombie-exit-not-forced (96% CPU
      // ghost daemon after SIGHUP handoff) traces here: the exit hammer
      // never landed. The 250ms cost vs. previous "maybe sub-250ms" is a
      // worthwhile trade for guaranteed termination.
      const exitCode = process.exitCode ?? 0
      setTimeout(() => process.exit(exitCode), 250)
    }

    opts.publishShutdown(shutdown)

    function run(): Promise<void> {
      return new Promise((resolve) => {
        if (t.scope.signal.aborted) {
          resolve()
          return
        }
        t.scope.signal.addEventListener("abort", () => resolve(), { once: true })
      })
    }

    return {
      ...t,
      runtime: { run, shutdown },
      run,
    }
  }
}
