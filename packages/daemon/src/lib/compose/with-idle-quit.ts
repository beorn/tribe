/**
 * withIdleQuit — connection-as-lease idle timer + socket-path-gone backstop.
 *
 * Liveness is a pure function of current state, not an event-driven timer:
 *
 *   - markActive() — clear the deadline (someone is using us)
 *   - markIdle()   — set the deadline (we may be done; checkLiveness decides)
 *   - checkLiveness() — runs from a 1s tick. Also:
 *     - Expires stale pending sessions that never sent a register message
 *       (60s grace window).
 *     - Triggers shutdown when the socket path on disk has been gone for
 *       ≥ 30s AND no clients are connected — backstop for the orphan-
 *       successor CPU-spin pattern. Only active when the daemon bound its
 *       own socket (inheritFd === null); inherited-fd daemons skip this
 *       check because the socket path may be unlinked by the donor.
 *
 * On `quitTimeoutSec < 0` the timer never fires (TRIBE_AUTOQUIT_ON_IDLE=-1). On
 * `quitTimeoutSec === 0` the daemon shuts down immediately when the registry
 * empties. Both paths are independent of the socket-path backstop.
 *
 * The factory takes:
 *   - `triggerShutdown()` — what to call when the idle deadline lapses.
 *   - `tickIntervalMs` (default 1000) — how often checkLiveness runs.
 *   - `pendingExpiryMs` (default 60000) — grace for half-registered sessions.
 *   - `socketPathGoneTimeoutMs` (default 30000) — how long socket path can
 *     be missing before self-bail. 0 disables the check.
 *
 * Bead: `@km/bearly/hot-reload-test-leaks-cpu-spinning-successors` (P1) —
 * pairs with the test-side defensive reap. Either fix in isolation closes
 * the user-visible symptom; both together close the failure mode.
 *
 * Cleanup: clearInterval registered on root scope.
 */

import { existsSync } from "node:fs"
import { createLogger } from "loggily"
import type { BaseTribe } from "./base.ts"
import type { WithClientRegistry } from "./with-client-registry.ts"
import type { WithConfig } from "./with-config.ts"

const log = createLogger("tribe:idle-quit")

export interface IdleQuitOpts {
  /** Called when the idle deadline lapses. Wired to the daemon's shutdown(). */
  triggerShutdown: () => void
  /** Tick interval — how often to evaluate liveness. Default 1000ms. */
  tickIntervalMs?: number
  /** Grace window for stale pending sessions. Default 60000ms. */
  pendingExpiryMs?: number
  /**
   * Backstop window — how long the socket path can be missing on disk
   * before the daemon self-bails (with no clients). Default 30000ms; 0
   * disables. Only active when the daemon bound its own socket
   * (inheritFd === null) — inherited-fd daemons skip this check because
   * the donor process may unlink the path mid-handoff.
   */
  socketPathGoneTimeoutMs?: number
  /**
   * Filesystem existence probe — primarily for tests. Defaults to
   * `existsSync` from node:fs. Tests inject a fake to simulate a
   * vanishing socket path without touching the real filesystem.
   */
  socketPathExists?: (path: string) => boolean
  /** Clock override — primarily for tests. Defaults to `Date.now`. */
  now?: () => number
}

export interface IdleQuit {
  markActive(): void
  markIdle(): void
  /** Currently scheduled deadline (ms epoch) or null when active. Tests inspect this. */
  getDeadline(): number | null
}

export interface WithIdleQuit {
  readonly idleQuit: IdleQuit
}

export function withIdleQuit<T extends BaseTribe & WithConfig & WithClientRegistry>(
  opts: IdleQuitOpts,
): (t: T) => T & WithIdleQuit {
  return (t) => {
    const quitTimeoutSec = t.config.quitTimeoutSec
    // Durations are written the way a reader says them. "21600s" is six hours and nobody
    // converts it under pressure.
    const dur = (s: number): string =>
      s >= 3600 ? `${Number((s / 3600).toFixed(2))}h` : s >= 60 ? `${Number((s / 60).toFixed(1))}m` : `${s}s`
    const clockAt = (ms: number): string => new Date(ms).toTimeString().slice(0, 5)
    // Disclose the CONFIG once at startup, separately from the EVENT that later trips it —
    // being switched on is not something that just happened. Saying it here also lets the two
    // event lines below stay short, and tells the reader the daemon can stop itself BEFORE
    // it does.
    log.info?.(
      quitTimeoutSec < 0
        ? `auto-quit-on-idle=off (TRIBE_AUTOQUIT_ON_IDLE=-1)`
        : `auto-quit-on-idle=${dur(quitTimeoutSec)} (TRIBE_AUTOQUIT_ON_IDLE)`,
    )
    const tickIntervalMs = opts.tickIntervalMs ?? 1000
    const pendingExpiryMs = opts.pendingExpiryMs ?? 60_000
    const socketPathGoneTimeoutMs = opts.socketPathGoneTimeoutMs ?? 30_000
    const socketPathExists = opts.socketPathExists ?? existsSync
    const now = opts.now ?? Date.now
    const { clients, socketToClient } = t.registry
    const socketPath = t.config.socketPath
    // The socket-path backstop is only meaningful when we bound our own
    // socket. Inherited-fd daemons (hot-reload successors) may legitimately
    // run after the donor unlinked the path — skip the check for them. The
    // donor cleanup path is fixed separately under
    // `@km/bearly/hot-reload-socket-unlink`.
    const socketPathWatchEnabled = socketPathGoneTimeoutMs > 0 && t.config.inheritFd === null

    let idleDeadline: number | null = null
    let socketPathGoneSince: number | null = null

    function markActive(): void {
      idleDeadline = null
    }

    function markIdle(): void {
      if (quitTimeoutSec < 0) return // -1 disables auto-quit
      if (idleDeadline !== null) return // already counting down
      idleDeadline = now() + quitTimeoutSec * 1000
      // WARN, not info: the daemon is announcing it intends to stop serving, and every seat
      // coordinates through this process. It logged at info on 2026-08-11 and nothing scanning
      // for warnings saw it — correctly, because nothing warned. The socket-missing backstop
      // below already uses warn for a strictly less severe condition.
      // observation => rule => consequence, and each term says something the others do not.
      // The consequence is a WALL CLOCK, not a countdown: "stopping at 17:22" tells a reader
      // whether to care right now; "in 21600s" makes them do arithmetic to find out.
      log.warn?.(`no clients => auto-quit-on-idle=${dur(quitTimeoutSec)} => stopping at ${clockAt(idleDeadline)}`)
    }

    function checkSocketPathGone(nowMs: number): void {
      if (!socketPathWatchEnabled) return
      // Path watch only matters when nobody is connected — a daemon with
      // live clients is still serving them via the bound fd even if the
      // path was unlinked out-of-band.
      if (clients.size > 0) {
        socketPathGoneSince = null
        return
      }
      const exists = socketPathExists(socketPath)
      if (exists) {
        socketPathGoneSince = null
        return
      }
      if (socketPathGoneSince === null) {
        socketPathGoneSince = nowMs
        log.warn?.(`socket path missing at ${socketPath} — starting backstop countdown`)
        return
      }
      if (nowMs - socketPathGoneSince >= socketPathGoneTimeoutMs) {
        log.warn?.(
          `daemon self-exit: socket path gone for ${Math.floor((nowMs - socketPathGoneSince) / 1000)}s and no clients ` +
            `(path=${socketPath})`,
        )
        opts.triggerShutdown()
      }
    }

    function checkLiveness(): void {
      const nowMs = now()
      // Expire pending sessions that never sent a register message
      for (const [connId, client] of clients) {
        if (client.role === "pending" && nowMs - client.registeredAt > pendingExpiryMs) {
          log.info?.(
            `Expiring stale pending session: ${client.name} (age=${Math.floor((nowMs - client.registeredAt) / 1000)}s)`,
          )
          clients.delete(connId)
          socketToClient.delete(client.socket)
          try {
            client.socket.destroy()
          } catch {
            /* already dead */
          }
        }
      }

      // Socket-path-gone backstop — independent of the idle-deadline path
      // because it has its own deadline and gates on a different signal
      // (path existence vs. client count over time).
      checkSocketPathGone(nowMs)

      if (idleDeadline === null) return
      // Defensive: if a client snuck in, abort the countdown
      if (clients.size > 0) {
        idleDeadline = null
        return
      }
      if (nowMs >= idleDeadline) {
        // WARN, and say what it MEANS rather than what fired. "idle deadline reached" reads like
        // a timer expiring; what happens is the coordination rail going down. The exit-is-clean
        // clause earns its place because a supervisor may still count it against a restart
        // budget — a config condition wearing a crash's clothes, which cost a morning on
        // 2026-08-11. The knob was already disclosed at startup; do not repeat it here.
        // Same three terms. The rule repeats even though startup disclosed it: this line is the
        // record of a DECISION, and decision records get quoted, pasted and read alone. "exit 0"
        // stays because a supervisor may still count this clean stop against a restart budget.
        log.warn?.(`idle ${dur(quitTimeoutSec)} => auto-quit-on-idle => stopping now (exit 0)`)
        opts.triggerShutdown()
      }
    }

    const interval = setInterval(checkLiveness, tickIntervalMs) as unknown as { unref?: () => void }
    interval.unref?.()
    t.scope.defer(() => clearInterval(interval as unknown as ReturnType<typeof setInterval>))

    // Begin idle countdown immediately. If a client connects before the
    // deadline, markActive() (called from withDispatcher's accept-handler)
    // clears it. This handles the case where a daemon is spawned but no client
    // ever connects (e.g. spawning test crashes).
    if (clients.size === 0) markIdle()

    return {
      ...t,
      idleQuit: { markActive, markIdle, getDeadline: () => idleDeadline },
    }
  }
}
