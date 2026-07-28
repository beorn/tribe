/**
 * withHotReload — SIGHUP-driven re-exec for picking up new daemon code.
 *
 * Two pieces:
 *
 *   1. `reload()` — stop plugins, then ask the declared lifecycle owner to
 *      replace the process. Hab-supervised services shut down cleanly so Hab
 *      can restart them. A supervised standalone daemon exits with its private
 *      reload code; a directly launched predecessor installs the same stable
 *      standalone owner before exiting. Successor daemons never self-detach.
 *
 *   2. Source file watcher — fs.watch on the daemon's source directories;
 *      coalesced via debounce; emits SIGHUP to the current process on change.
 *      Skipped when `disableWatch: true` (tests) or `TRIBE_NO_AUTORELOAD=1`.
 *
 * The factory takes runtime callbacks the daemon supplies: `stopPlugins()`
 * flushes plugin cursors; `triggerShutdown()` releases a standalone predecessor;
 * and optional `replaceProcess()` delegates to a stable supervisor. The
 * withSignals factory routes SIGHUP to `reload()`.
 */

import { existsSync, readdirSync, readFileSync, unlinkSync, watch, type FSWatcher } from "node:fs"
import { createHash } from "node:crypto"
import { dirname as pathDirname, resolve as pathResolve } from "node:path"
import { createLogger } from "loggily"
import { spawnStandaloneDaemonSupervisor } from "tribe-wire"
import type { BaseTribe } from "./base.ts"
import type { WithConfig } from "./with-config.ts"
import type { WithSocketServer } from "./with-socket-server.ts"

const log = createLogger("tribe:hot-reload")

export interface HotReloadOpts {
  /** Called before re-exec so plugin state flushes to disk. */
  stopPlugins: () => void
  /** Called after the spawn delay to abort/exit the current process. */
  triggerShutdown: () => void
  /** Delegate replacement to an existing stable process supervisor. */
  replaceProcess?: (reason: string) => void
  /** Skip the source-watcher (tests + non-source bundles). */
  disableWatch?: boolean
  /** ms between debounced source-change → SIGHUP emit. Default 500. */
  watchDebounceMs?: number
  /** ms to give the new process before the old exits. Default 1000. */
  spawnDelayMs?: number
}

export interface HotReload {
  /** Trigger replacement through the active lifecycle owner. */
  reload(): void
  /** Active watchers — exposed so tests can await close(). */
  readonly watchers: ReadonlyArray<FSWatcher>
}

export interface WithHotReload {
  readonly hotReload: HotReload
}

export function reloadReplacementForEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  shutdown: () => void,
  parentPid = process.ppid,
): ((reason: string) => void) | undefined {
  if (env.HAB_SERVICE_KIND === "service") return () => shutdown()

  const supervisorPid = Number(env.TRIBE_DAEMON_SUPERVISOR_PID)
  const reloadExitCode = Number(env.TRIBE_DAEMON_RELOAD_EXIT_CODE)
  const hasStandaloneOwner =
    Number.isSafeInteger(supervisorPid) &&
    supervisorPid > 1 &&
    supervisorPid === parentPid &&
    Number.isSafeInteger(reloadExitCode) &&
    reloadExitCode > 0 &&
    reloadExitCode <= 255
  if (!hasStandaloneOwner) return undefined
  return () => {
    process.exitCode = reloadExitCode
    shutdown()
  }
}

function buildSourceFiles(sourceDir: string, libTribeDir: string): string[] {
  return [
    pathResolve(sourceDir, "tribe-daemon.ts"),
    pathResolve(sourceDir, "stdio-adapter.ts"),
    ...(() => {
      try {
        return readdirSync(libTribeDir)
          .filter((f) => f.endsWith(".ts"))
          .sort()
          .map((f) => pathResolve(libTribeDir, f))
      } catch {
        // silent-fallback-allow: unreadable plugin source dir just omits extra files from hot-reload hashing.
        return []
      }
    })(),
  ]
}

function computeSourceHash(files: string[]): string {
  const hash = createHash("md5")
  for (const f of files) {
    try {
      hash.update(readFileSync(f))
    } catch {
      /* missing */
    }
  }
  return hash.digest("hex").slice(0, 12)
}

export function withHotReload<T extends BaseTribe & WithConfig & WithSocketServer>(
  opts: HotReloadOpts,
): (t: T) => T & WithHotReload {
  return (t) => {
    const spawnDelayMs = opts.spawnDelayMs ?? 1000
    const watchDebounceMs = opts.watchDebounceMs ?? 500

    function reload(): void {
      const reason = "SIGHUP received — re-exec for hot-reload"
      log.info?.(reason)
      // Stop plugins before either replacement path so cursor/state flushes
      // before the process changes.
      opts.stopPlugins()
      if (opts.replaceProcess) {
        opts.replaceProcess(reason)
        return
      }

      // A directly launched standalone daemon has no durable owner yet.
      // Install the same repo-local supervisor used by connectOrStart, but ask
      // it to wait for this predecessor to exit before it starts the next
      // generation. The supervisor may detach; the daemon never does.
      //
      // Mark the socket as handed off BEFORE closing so the scope-cleanup
      // defer in withSocketServer skips its own unlink (it would otherwise
      // race the replacement daemon's fresh bind).
      t.socket.handedOff = true
      try {
        t.socket.server.close()
      } catch {
        /* already closing */
      }
      try {
        if (existsSync(t.socket.socketPath)) unlinkSync(t.socket.socketPath)
      } catch {
        /* not present or no permission */
      }

      const argv = process.argv.slice(1).filter((a) => !a.startsWith("--fd"))
      const operatorCapability = t.config.operatorCapability?.trim() || null
      const child = spawnStandaloneDaemonSupervisor({
        daemonScript: argv[0]!,
        daemonArgs: argv.slice(1),
        operatorCapability,
        waitForPid: process.pid,
      })

      child.on("error", (err) => {
        log.info?.(`Hot-reload lifecycle owner failed: ${err.message}`)
      })

      // Give the supervisor time to start and enter its predecessor wait before
      // exiting. Do NOT unref the timer: it owns forward progress to shutdown.
      setTimeout(() => {
        log.info?.("Hot-reload: old process exiting under the new lifecycle owner")
        opts.triggerShutdown()
      }, spawnDelayMs)

      // Belt-and-braces nuke: if triggerShutdown + withRuntime's force-exit
      // hammer somehow still don't terminate this process — say a sync-heavy
      // plugin starves both timers' callbacks — SIGKILL self at
      // spawnDelayMs + 1500ms. Synchronous, kernel-enforced, can't be
      // starved. This is the last line of defense; previous fixes (dropping
      // .unref() on both timers) should make it unreachable in practice,
      // but the historical zombie-daemon incident proved we need the hammer.
      setTimeout(() => {
        log.info?.("Hot-reload: belt-and-braces SIGKILL — clean shutdown did not terminate process")
        try {
          process.kill(process.pid, "SIGKILL")
        } catch {
          /* even the kill failed; nothing left to try */
        }
      }, spawnDelayMs + 1500)
    }

    // Source-file watcher — auto-SIGHUP on code changes.
    const watchers: FSWatcher[] = []
    if (!opts.disableWatch && !process.env.TRIBE_NO_AUTORELOAD) {
      const sourceDir = pathDirname(new URL(import.meta.url).pathname)
      // Resolve relative to the actual tribe-daemon location (one level up
      // from this compose/ dir; lib/tribe sits next to it).
      const toolsDir = pathResolve(sourceDir, "../../../")
      const libTribeDir = pathResolve(sourceDir, "../")
      const sourceFiles = buildSourceFiles(toolsDir, libTribeDir)

      let sourceHash = computeSourceHash(sourceFiles)
      let reloadDebounce: ReturnType<typeof setTimeout> | null = null

      const onSourceChange = (filename: string | null): void => {
        if (filename && !filename.endsWith(".ts")) return
        if (reloadDebounce) clearTimeout(reloadDebounce)
        reloadDebounce = setTimeout(() => {
          const newHash = computeSourceHash(sourceFiles)
          if (newHash === sourceHash) return // No actual change
          log.info?.(`Source changed (${sourceHash} → ${newHash}), triggering hot-reload`)
          sourceHash = newHash
          process.emit("SIGHUP")
        }, watchDebounceMs)
      }

      try {
        watchers.push(watch(toolsDir, { persistent: false }, (_event, filename) => onSourceChange(filename)))
      } catch {
        /* dir not present in compiled bundle */
      }
      if (existsSync(libTribeDir)) {
        try {
          watchers.push(watch(libTribeDir, { persistent: false }, (_event, filename) => onSourceChange(filename)))
        } catch {
          /* permission denied or similar */
        }
      }

      log.info?.(`Watching source files for auto-reload`)

      t.scope.defer(() => {
        if (reloadDebounce) clearTimeout(reloadDebounce)
        for (const w of watchers) {
          try {
            w.close()
          } catch {
            /* already closed */
          }
        }
      })
    }

    return {
      ...t,
      hotReload: { reload, watchers },
    }
  }
}
