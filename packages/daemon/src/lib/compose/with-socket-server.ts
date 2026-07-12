/**
 * withSocketServer — bind the Unix socket the daemon listens on.
 *
 * Two cases:
 *
 *   1. Hot-reload: `--fd N` inherits an already-bound listening fd from the
 *      previous process (`withHotReload` re-execs with the fd preserved).
 *
 *   2. Fresh start: bind + chmod 0600. The caller is responsible for any
 *      pre-bind alive-probe — `pipe(...)` is synchronous, so async work like
 *      probing a remote socket happens outside the pipe (see
 *      `probeAndCleanSocket()` exported below for the standard probe routine).
 *
 * The server is created but no `connection` handler is attached here — that
 * is `withDispatcher`'s job. Node `Server` accepts post-listen `.on("connection",
 * fn)` listeners; subsequent accepts fire the listener.
 *
 * Cleanup: server.close() + (when not inheriting) unlinkSync(socketPath)
 * registered on root scope.
 */

import { createServer, type Server } from "node:net"
import { existsSync, unlinkSync, chmodSync } from "node:fs"
import { createLogger } from "loggily"
import { waitForSocketAlive } from "tribe-wire/lib/socket"
import { evaluateSpawnSourceForTree, writePinSidecar } from "tribe-wire/lib/spawn-pin-gate"
import { STARTUP_SHA } from "../code-pin.ts"
import type { BaseTribe } from "./base.ts"
import type { WithConfig } from "./with-config.ts"

const log = createLogger("tribe:socket")

export interface SocketServer {
  readonly server: Server
  readonly socketPath: string
  /** Resolves only after this candidate either owns the socket or loses the bind election. */
  readonly binding: Promise<"listening" | "occupied">
  /** True when the server bound to an inherited fd (hot-reload re-exec). */
  readonly inheritedFd: boolean
  /** Wall-clock ms when bind completed — used for join-suppress window etc. */
  readonly startedAt: number
  /**
   * Set by `withHotReload.reload()` once the socket has been closed + unlinked
   * and a replacement daemon spawned. Signals the scope-cleanup defer below to
   * SKIP its own `unlinkSync` — otherwise the dying daemon's delayed cleanup
   * could delete the freshly-bound socket of the replacement daemon.
   */
  handedOff: boolean
}

export interface WithSocketServer {
  readonly socket: SocketServer
}

/**
 * Probe an existing socket path. If a live daemon is listening, returns true
 * (caller should `process.exit(0)`). If the socket exists but is stale,
 * removes it and returns false. If the socket doesn't exist, returns false.
 *
 * Async — meant to run BEFORE the pipe call. See hub/composition.md
 * § "Async — outside the pipe".
 */
export async function probeAndCleanSocket(socketPath: string): Promise<boolean> {
  if (!existsSync(socketPath)) return false
  // Retry the liveness probe before declaring the socket stale. A single probe
  // can transiently fail against a LIVE daemon (full accept backlog, hot-reload
  // re-exec window, socket mid-churn during a startup storm). Unlinking a live
  // socket here would orphan the running daemon and let THIS process bind a
  // competing one — the split-brain that left every pane "active-pane-no-tribe".
  // waitForSocketAlive biases toward detecting life. See tribe-wire client.ts.
  const alive = await waitForSocketAlive(socketPath)
  if (alive) return true
  try {
    unlinkSync(socketPath)
  } catch {
    /* ignore */
  }
  return false
}

/**
 * withSocketServer — bind the Unix socket. Synchronous. The fresh-start path
 * assumes the caller has already invoked `probeAndCleanSocket(...)` to handle
 * stale-socket cleanup and another-daemon-running detection.
 */
export function withSocketServer<T extends BaseTribe & WithConfig>(): (t: T) => T & WithSocketServer {
  return (t) => {
    const socketPath = t.config.socketPath
    const inheritFd = t.config.inheritFd

    let server: Server
    let inheritedFd = false
    // True once THIS process owns the bound socket file (fresh-start path). A
    // daemon that lost a cold-start bind race (EADDRINUSE — its listen callback
    // never fires) leaves this false, so its cleanup defer below will NOT unlink
    // the winner's socket. Guards against a losing daemon orphaning the winner.
    let bound = false
    let resolveBinding!: (result: "listening" | "occupied") => void
    let rejectBinding!: (error: Error) => void
    const binding = new Promise<"listening" | "occupied">((resolve, reject) => {
      resolveBinding = resolve
      rejectBinding = reject
    })
    const onBindError = (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        resolveBinding("occupied")
        return
      }
      rejectBinding(error)
    }

    if (inheritFd !== null) {
      server = createServer()
      server.once("error", onBindError)
      server.listen({ fd: inheritFd }, () => {
        server.removeListener("error", onBindError)
        bound = true
        resolveBinding("listening")
      })
      inheritedFd = true
      log.info?.(`Inherited socket fd ${inheritFd} (hot-reload)`)
    } else {
      // 21052 — the daemon's own door of the stale-pin gate: refuse to bind
      // when THIS source tree is provably older than the last pin that bound
      // this socket (the adapter-side gate in connectOrStart is the first
      // door; this one catches spawns that bypass it). Loud fail-closed.
      const pinGate = evaluateSpawnSourceForTree(import.meta.dir, socketPath)
      if (!pinGate.allow) {
        throw new Error(`refusing to bind ${socketPath}: ${pinGate.reason}`)
      }
      if (pinGate.reason) log.warn?.(pinGate.reason)
      server = createServer()
      server.once("error", onBindError)
      server.listen(socketPath, () => {
        server.removeListener("error", onBindError)
        bound = true
        try {
          chmodSync(socketPath, 0o600)
        } catch {
          /* not all platforms support it */
        }
        // Record the pin that now owns this socket; the sidecar deliberately
        // survives daemon death — "the last pin that ever bound" is the
        // reference future auto-spawns must not downgrade past.
        writePinSidecar(socketPath, STARTUP_SHA)
        resolveBinding("listening")
        log.info?.(`Listening on ${socketPath}`)
      })
    }

    const socket: SocketServer = {
      server,
      socketPath,
      binding,
      inheritedFd,
      startedAt: Date.now(),
      handedOff: false,
    }

    // Cleanup — close the server and unlink the socket file. Skipped when this
    // daemon handed the socket off to a replacement during hot-reload: in that
    // case `reload()` already closed + unlinked, and the replacement may have
    // re-bound a fresh socket at the same path that we must NOT delete.
    t.scope.defer(() => {
      try {
        server.close()
      } catch {
        /* already closing */
      }
      if (!inheritedFd && !socket.handedOff && bound) {
        try {
          unlinkSync(socketPath)
        } catch {
          /* not present or no permission */
        }
      }
    })
    return { ...t, socket }
  }
}
