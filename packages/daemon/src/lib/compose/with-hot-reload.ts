/**
 * withHotReload — SIGHUP-driven re-exec for picking up new daemon code, behind
 * a safe-reload admission gate (@ag/tribe/20703).
 *
 * User doctrine 2026-07-13: watch-triggered hot-reload STAYS — staleness has
 * cost us more than reloads — but a reload must never replace a working daemon
 * with a broken one, and must be observable. ONE pipeline, two triggers:
 *
 *   watch (fs change → debounced SIGHUP) and explicit (`tribe reload` /
 *   SIGHUP) both land in `reload()`, which runs the admission gate before any
 *   re-exec.
 *
 * Pieces:
 *
 *   1. `reload()` — admission-gated re-exec. First `runAdmissionPrecheck`
 *      spawns the ON-DISK daemon entry with `--precheck` (module graph loads,
 *      exits before any DB open / socket bind — see daemon.ts). Only on a
 *      passing precheck: close + unlink the listening socket, then spawn a
 *      DETACHED replacement (`detached:true` + `unref()`, no `--fd`) that
 *      binds the freed socket path fresh. The old process exits after a short
 *      delay. (Earlier versions passed the listening fd to the child for
 *      zero-gap handoff, but Bun's `node:net` cannot `listen({ fd })` — fd
 *      inheritance crash-looped the child. Close-then-fresh-bind costs a
 *      sub-second reconnect window but works under Bun.) On a FAILING
 *      precheck: NO re-exec, plugins keep running, socket stays bound, and a
 *      `daemon:reload-refused` event carries the literal candidate error.
 *      THE INVARIANT: a broken source tree can never take down a working
 *      daemon.
 *
 *   2. Post-reload verify — the replacement daemon boots with
 *      `__TRIBE_RELOAD_VERIFY=1` + `__TRIBE_RELOAD_FROM_SHA=<old sha>`; once
 *      its socket reports "listening" it probes its own `tribe.health` and
 *      emits `daemon:reload-ok` (green) or `daemon:reload-degraded` (red,
 *      LOUD, naming the degraded facts) stamped old→new SHA from the code-pin
 *      machinery. No auto-rollback in this slice — the design note for
 *      generation-pinned snapshots + rollback (and why full blue-green waits
 *      for attach-by-token) lives in tribe-wire's lib/hot-reload.ts.
 *
 *   3. Source file watcher — fs.watch on the daemon's source directories;
 *      coalesced via the shared reload debouncer (default 2s window,
 *      `TRIBE_RELOAD_DEBOUNCE_MS`) so a gitlink bump touching 50 files fires
 *      ONE reload; emits SIGHUP to the current process on change. Skipped
 *      when `disableWatch: true` (tests) or `TRIBE_NO_AUTORELOAD=1`.
 *
 * The factory takes runtime callbacks the daemon supplies: `stopPlugins()`
 * (called before spawn so plugin cursors flush — only AFTER admission),
 * `triggerShutdown()` (called after the spawn delay to release the old
 * process), `emitEvent` (reload events onto the tribe wire), `probeHealth`
 * (the new generation's self-check). The withSignals factory routes SIGHUP to
 * `reload()`.
 */

import { spawn } from "node:child_process"
import { existsSync, readdirSync, readFileSync, unlinkSync, watch, type FSWatcher } from "node:fs"
import { createHash } from "node:crypto"
import { dirname as pathDirname, resolve as pathResolve } from "node:path"
import { createLogger } from "loggily"
import {
  createReloadDebouncer,
  reloadDebounceMs,
  reloadPrecheckTimeoutMs,
  runAdmissionPrecheck,
  type AdmissionResult,
} from "tribe-wire/lib/hot-reload"
import { STARTUP_SHA } from "../code-pin.ts"
import type { BaseTribe } from "./base.ts"
import type { WithSocketServer } from "./with-socket-server.ts"

const log = createLogger("tribe:hot-reload")

// ---------------------------------------------------------------------------
// Reload event types — the observable contract. Emitted on the tribe wire
// (broadcast + activity log via the daemon's emitEvent wiring) so every seat
// and the health-monitor can see reload outcomes without scraping logs.
// ---------------------------------------------------------------------------

/** A candidate source tree failed admission; the running generation stays. */
export const RELOAD_REFUSED = "daemon:reload-refused"
/** A new generation booted and its health probe came back clean. */
export const RELOAD_OK = "daemon:reload-ok"
/** A new generation booted but reports degraded facts (or the probe failed). */
export const RELOAD_DEGRADED = "daemon:reload-degraded"

/** Env markers the committing generation stamps on the replacement so the new
 *  process knows to run the post-reload verify and against which baseline. */
const VERIFY_ENV = "__TRIBE_RELOAD_VERIFY"
const FROM_SHA_ENV = "__TRIBE_RELOAD_FROM_SHA"

type ReloadLog = { info?: (msg: string) => void; warn?: (msg: string) => void }

const shortSha = (sha: string | null): string => (sha ? sha.slice(0, 12) : "unknown")

// ---------------------------------------------------------------------------
// Pure core 1 — admission-gated reload decision.
// ---------------------------------------------------------------------------

export interface AdmitAndReloadDeps {
  /** Run the candidate precheck (real: runAdmissionPrecheck on the entry). */
  runPrecheck: () => Promise<AdmissionResult>
  /** Commit the re-exec (socket handoff + detached spawn + exit timers). */
  commitReExec: () => void
  /** Emit an observable reload event (type, content). */
  emit: (type: string, content: string) => void
  /** Log sink override (tests). Defaults to this module's logger. */
  log?: ReloadLog
}

/**
 * The admission gate: precheck the candidate, then EITHER commit the re-exec
 * (exactly once) or refuse it — keep serving on the current generation, log
 * loud, and emit `daemon:reload-refused` with the literal candidate error.
 * A precheck that itself throws is a refusal, never an admission (fail-closed).
 */
export async function admitAndReload(
  deps: AdmitAndReloadDeps,
): Promise<{ admitted: boolean; precheck: AdmissionResult }> {
  const lg = deps.log ?? log
  let precheck: AdmissionResult
  try {
    precheck = await deps.runPrecheck()
  } catch (err) {
    precheck = {
      ok: false,
      code: null,
      signal: null,
      timedOut: false,
      stderr: `precheck runner threw: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  if (!precheck.ok) {
    const why = precheck.timedOut
      ? `candidate precheck timed out (killed; the candidate hung before completing module-graph load)`
      : `candidate precheck exited ${precheck.code === null ? `via signal ${precheck.signal ?? "unknown"}` : `code ${precheck.code}`}${precheck.stderr ? `: ${precheck.stderr}` : ""}`
    const content = `hot-reload REFUSED — keeping current generation (pid=${process.pid}, running=${shortSha(STARTUP_SHA)}): ${why}`
    lg.warn?.(content)
    deps.emit(RELOAD_REFUSED, content)
    return { admitted: false, precheck }
  }

  deps.commitReExec()
  return { admitted: true, precheck }
}

// ---------------------------------------------------------------------------
// Pure core 2 — post-reload health verification (runs in the NEW generation).
// ---------------------------------------------------------------------------

export interface PostReloadVerifyDeps {
  /** Probe this daemon's own health — the `degraded` contract from handleHealth. */
  probeHealth: () => Promise<{ degraded: string[] }>
  /** SHA the previous generation ran (from the env marker), null if unknown. */
  fromSha: string | null
  /** SHA this generation loaded (code-pin STARTUP_SHA), null if unknown. */
  toSha: string | null
  /** Emit an observable reload event (type, content). */
  emit: (type: string, content: string) => void
  /** Log sink override (tests). Defaults to this module's logger. */
  log?: ReloadLog
}

/**
 * The new generation's self-check: probe `tribe.health` once ready and emit
 * `daemon:reload-ok` (clean) or `daemon:reload-degraded` (degraded facts named,
 * LOUD). A probe failure is itself a degraded outcome — never silent.
 */
export async function runPostReloadVerify(deps: PostReloadVerifyDeps): Promise<{ ok: boolean; degraded: string[] }> {
  const lg = deps.log ?? log
  const gen = `${shortSha(deps.fromSha)} → ${shortSha(deps.toSha)}`
  let degraded: string[]
  try {
    degraded = (await deps.probeHealth()).degraded
  } catch (err) {
    const content = `hot-reload DEGRADED (${gen}): post-reload health probe failed: ${err instanceof Error ? err.message : String(err)}`
    lg.warn?.(content)
    deps.emit(RELOAD_DEGRADED, content)
    return { ok: false, degraded: [] }
  }
  if (degraded.length > 0) {
    const content = `hot-reload DEGRADED (${gen}): new generation reports degraded facts: ${degraded.join(", ")}`
    lg.warn?.(content)
    deps.emit(RELOAD_DEGRADED, content)
    return { ok: false, degraded }
  }
  const content = `hot-reload ok (${gen}): new generation healthy`
  lg.info?.(content)
  deps.emit(RELOAD_OK, content)
  return { ok: true, degraded: [] }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface HotReloadOpts {
  /** Called before re-exec so plugin state flushes to disk (only on ADMITTED reloads). */
  stopPlugins: () => void
  /** Called after the spawn delay to abort/exit the current process. */
  triggerShutdown: () => void
  /** Emit an observable reload event onto the tribe wire (broadcast + journal). */
  emitEvent: (type: string, content: string) => void
  /** Probe this daemon's own tribe.health `degraded` contract (post-reload verify). */
  probeHealth: () => Promise<{ degraded: string[] }>
  /** Skip the source-watcher (tests + non-source bundles). */
  disableWatch?: boolean
  /** Skip the boot-time post-reload verify (tests). */
  disableVerify?: boolean
  /** ms between debounced source-change → SIGHUP emit.
   *  Default `reloadDebounceMs()` (2s; TRIBE_RELOAD_DEBOUNCE_MS). */
  watchDebounceMs?: number
  /** ms to give the new process before the old exits. Default 1000. */
  spawnDelayMs?: number
  /** Admission precheck timeout.
   *  Default `reloadPrecheckTimeoutMs()` (30s; TRIBE_RELOAD_PRECHECK_TIMEOUT_MS). */
  precheckTimeoutMs?: number
  /** Test seam — replace the real candidate spawn with a canned result. */
  precheckRunner?: () => Promise<AdmissionResult>
}

export interface HotReload {
  /** Trigger an admission-gated re-exec. The withSignals factory wires SIGHUP here. */
  reload(): void
  /** Active watchers — exposed so tests can await close(). */
  readonly watchers: ReadonlyArray<FSWatcher>
}

export interface WithHotReload {
  readonly hotReload: HotReload
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

export function withHotReload<T extends BaseTribe & WithSocketServer>(
  opts: HotReloadOpts,
): (t: T) => T & WithHotReload {
  return (t) => {
    const spawnDelayMs = opts.spawnDelayMs ?? 1000
    const watchDebounceMs = opts.watchDebounceMs ?? reloadDebounceMs()

    // -----------------------------------------------------------------------
    // Post-reload verify (this process IS the new generation when the env
    // marker is present). Read + clear the markers unconditionally so they
    // never leak into further children; run the verify once the socket
    // reports "listening" — that is "ready": DB open, dispatcher attached.
    // -----------------------------------------------------------------------
    const verifyRequested = process.env[VERIFY_ENV] === "1"
    const verifyFromSha = process.env[FROM_SHA_ENV] || null
    delete process.env[VERIFY_ENV]
    delete process.env[FROM_SHA_ENV]
    if (verifyRequested && !opts.disableVerify) {
      void t.socket.binding
        .then(async (binding) => {
          if (binding !== "listening") return // lost the bind election — no generation to verify
          await runPostReloadVerify({
            probeHealth: opts.probeHealth,
            fromSha: verifyFromSha,
            toSha: STARTUP_SHA,
            emit: opts.emitEvent,
          })
        })
        .catch((err: unknown) => {
          // runPostReloadVerify contains its probe errors; reaching here means
          // emit/binding itself failed — still loud, never silent.
          log.warn?.(`post-reload verify could not run: ${err instanceof Error ? err.message : String(err)}`)
        })
    }

    // -----------------------------------------------------------------------
    // Commit path — the pre-existing hardened re-exec, unchanged except that
    // it now runs only AFTER admission and stamps the verify env markers.
    // -----------------------------------------------------------------------
    function commitReExec(): void {
      log.info?.("hot-reload admitted — re-exec for new generation")
      // Stop plugins BEFORE spawning so cursor/state flushes to disk
      // (prevents duplicate event delivery in the new process). Deliberately
      // NOT done for refused reloads — a refused reload must leave the
      // running generation fully intact, plugins included.
      opts.stopPlugins()

      // Re-exec strategy: close-then-spawn-detached-fresh.
      //
      // The previous strategy passed the listening socket fd to the child
      // (`--fd=N` + `stdio[3]=fd`) so it could inherit the bound socket. That
      // only works under Node — Bun's `node:net` throws "Bun does not support
      // listening on a file descriptor" on `server.listen({ fd })`. Under Bun
      // the child crash-looped on startup, the old daemon exited anyway, and
      // every session saw "No daemon running" (reproduced 2026-05-21 via the
      // `tribe.reload` MCP tool, which routes here through SIGHUP).
      //
      // Instead: the OLD daemon closes + unlinks the socket, then spawns the
      // replacement DETACHED (its own session via `detached:true` + `unref()`,
      // so it survives this process's exit) with a FRESH bind — no `--fd`.
      // The child binds the now-free socket path. There is a sub-second
      // window with no listener; adapters reconnect transparently via
      // `createReconnectingClient`'s backoff. Crucially the daemon SURVIVES
      // a reload — `detached` severs it from the dying parent's lifecycle.
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

      const child = spawn(process.execPath, argv, {
        stdio: "ignore",
        detached: true,
        env: {
          ...process.env,
          // The replacement runs the post-reload verify against this baseline.
          [VERIFY_ENV]: "1",
          [FROM_SHA_ENV]: STARTUP_SHA ?? "",
        },
      })
      child.unref()

      child.on("error", (err) => {
        log.info?.(`Hot-reload spawn failed: ${err.message}`)
      })

      // Give new process time to start, then exit. Use a raw setTimeout here —
      // we WANT this timer to fire even after `triggerShutdown()` is initiated
      // by something else, because the new process needs the old one out of
      // the way to take over the fd cleanly. Do NOT unref — if every other
      // handle is also unref'd or the loop is sync-starved, the donor stays
      // alive serving its now-dead state. See @km/bearly/hot-reload-zombie-
      // exit-not-forced for the zombie-daemon incident.
      setTimeout(() => {
        log.info?.("Hot-reload: old process exiting, new process taking over")
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

    // -----------------------------------------------------------------------
    // Admission precheck of the ON-DISK entry (the candidate source tree).
    // -----------------------------------------------------------------------
    function runPrecheck(): Promise<AdmissionResult> {
      if (opts.precheckRunner) return opts.precheckRunner()
      const entry = process.argv[1]
      if (!entry) {
        // Fail-closed: no locatable entry means no way to validate a
        // candidate — refuse rather than blind-fire a re-exec.
        return Promise.resolve({
          ok: false,
          code: null,
          signal: null,
          timedOut: false,
          stderr: "cannot locate daemon entry (process.argv[1] is empty) — refusing reload",
        } satisfies AdmissionResult)
      }
      return runAdmissionPrecheck({
        entry,
        args: process.argv.slice(2).filter((a) => !a.startsWith("--fd")),
        timeoutMs: opts.precheckTimeoutMs ?? reloadPrecheckTimeoutMs(),
      })
    }

    // ONE pipeline, two triggers: both the watcher's debounced SIGHUP and an
    // explicit `tribe reload` / SIGHUP land here and pass the admission gate.
    let reloadInFlight = false
    function reload(): void {
      if (reloadInFlight) {
        log.info?.("hot-reload already in flight — trigger coalesced")
        return
      }
      reloadInFlight = true
      log.info?.("reload requested — running admission precheck on the on-disk source")
      void admitAndReload({ runPrecheck, commitReExec, emit: opts.emitEvent })
        .catch((err: unknown) => {
          // admitAndReload is fail-closed internally; reaching here means the
          // emit wiring itself threw. Loud, and the daemon keeps serving.
          log.warn?.(
            `hot-reload admission error (daemon keeps serving): ${err instanceof Error ? err.message : String(err)}`,
          )
        })
        .finally(() => {
          reloadInFlight = false
        })
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

      // Shared debouncer: N fs events inside the window → ONE flush → ONE
      // SIGHUP → ONE admission-gated reload. (Pre-20703 this was a bare 500ms
      // timer; a gitlink bump spread over >500ms double-fired the re-exec.)
      const debouncer = createReloadDebouncer({
        windowMs: watchDebounceMs,
        onFlush: () => {
          const newHash = computeSourceHash(sourceFiles)
          if (newHash === sourceHash) return // No actual change
          log.info?.(`Source changed (${sourceHash} → ${newHash}), triggering hot-reload`)
          sourceHash = newHash
          process.emit("SIGHUP")
        },
      })

      const onSourceChange = (filename: string | null): void => {
        if (filename && !filename.endsWith(".ts")) return
        debouncer.trigger()
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
        debouncer[Symbol.dispose]()
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
