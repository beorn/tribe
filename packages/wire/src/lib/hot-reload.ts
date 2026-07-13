/**
 * Hot-reload — watch source files and re-exec on change.
 *
 * Only activates when running from source (import.meta.url is a file:// URL
 * pointing into the repo). Bundled builds (server.ts) skip this.
 *
 * ---------------------------------------------------------------------------
 * Safe-reload gate (@ag/tribe/20703). User doctrine 2026-07-13: watch-triggered
 * hot-reload STAYS — staleness has cost us more than reloads — but a reload
 * must never replace a working process with a broken one, and must be
 * observable. The two reusable primitives below are the shared, consumer-
 * agnostic pieces of that gate:
 *
 *   - `createReloadDebouncer` — coalesces a burst of source-change events
 *     (a gitlink bump touching 50 files) into exactly ONE reload.
 *   - `runAdmissionPrecheck` — spawns the candidate entry with a precheck flag
 *     that loads the module graph and exits BEFORE opening a DB / binding a
 *     socket. A broken source tree exits non-zero, so the caller can refuse the
 *     re-exec and keep serving on the current generation.
 *
 * The daemon's `withHotReload` compose stage consumes both today. The stdio
 * adapter (`stdio-adapter.ts`, owned elsewhere this wave) uses
 * `setupHotReload` below — it already coalesces via the shared debouncer, and
 * can adopt `runAdmissionPrecheck` in a follow-up so a broken adapter source
 * tree can never take down a working adapter either.
 */

import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, watch, type FSWatcher } from "node:fs"
import { dirname, resolve } from "node:path"
import { spawn } from "node:child_process"
import { createLogger } from "loggily"

const log = createLogger("tribe:reload")

// ---------------------------------------------------------------------------
// Reusable primitive 1 — debounced reload coalescer.
// ---------------------------------------------------------------------------

/** Default coalescing window. A gitlink bump can write dozens of files over
 *  a few hundred ms; 2s absorbs the whole burst into one reload. Env-tunable
 *  via `TRIBE_RELOAD_DEBOUNCE_MS`. */
export const DEFAULT_RELOAD_DEBOUNCE_MS = 2000

/** Resolve the debounce window from the env knob, falling back to the default.
 *  A non-positive / unparseable value keeps the default (never 0 — a 0-window
 *  defeats coalescing). */
export function reloadDebounceMs(fallback = DEFAULT_RELOAD_DEBOUNCE_MS): number {
  const raw = process.env.TRIBE_RELOAD_DEBOUNCE_MS
  if (raw === undefined) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export interface ReloadDebouncer extends Disposable {
  /** Register a source-change event. Restarts the coalescing window. */
  trigger(): void
  /** True while a flush is scheduled (window open). */
  readonly pending: boolean
}

/**
 * Coalesce a burst of `trigger()` calls into a single `onFlush()` after
 * `windowMs` of quiet. Re-arms after each flush so a later change reloads
 * again. `onFlush` throwing is logged, never propagated (a watcher callback
 * must not crash the process). Dispose cancels any pending flush.
 */
export function createReloadDebouncer(opts: { windowMs: number; onFlush: () => void }): ReloadDebouncer {
  const { windowMs, onFlush } = opts
  let timer: ReturnType<typeof setTimeout> | null = null

  return {
    trigger(): void {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        try {
          onFlush()
        } catch (err) {
          log.info?.(`reload debouncer onFlush threw: ${err instanceof Error ? err.message : String(err)}`)
        }
      }, windowMs)
    },
    get pending(): boolean {
      return timer !== null
    },
    [Symbol.dispose](): void {
      if (timer) clearTimeout(timer)
      timer = null
    },
  }
}

// ---------------------------------------------------------------------------
// Reusable primitive 2 — admission precheck of a candidate source tree.
// ---------------------------------------------------------------------------

export interface AdmissionResult {
  /** True iff the candidate loaded its module graph and exited 0. */
  ok: boolean
  /** Child exit code (null when killed by signal / timeout). */
  code: number | null
  /** Signal that terminated the child, if any. */
  signal: NodeJS.Signals | null
  /** True when the precheck exceeded `timeoutMs` and was killed. */
  timedOut: boolean
  /** Captured stderr (trimmed) — the literal error for a refused reload. */
  stderr: string
}

export interface AdmissionPrecheckOpts {
  /** Candidate module entry to load (the on-disk source about to replace us). */
  entry: string
  /** Extra argv to pass through (the daemon's own args, minus --fd). */
  args?: string[]
  /** Runtime to spawn with. Default: the current `process.execPath` (bun). */
  execPath?: string
  /** Flag the entry recognises to exit 0 after module-graph load. Default `--precheck`. */
  precheckFlag?: string
  /** Kill + fail after this many ms (module load should be fast). Default 30s. */
  timeoutMs?: number
  /** Env for the child. Default: the current process env. */
  env?: NodeJS.ProcessEnv
}

/** Default precheck timeout — module-graph load is fast; a candidate that
 *  takes longer is stuck and must not block a working process indefinitely.
 *  Env-tunable via `TRIBE_RELOAD_PRECHECK_TIMEOUT_MS`. */
export const DEFAULT_PRECHECK_TIMEOUT_MS = 30_000

/** Resolve the precheck timeout from the env knob, falling back to the
 *  default. Non-positive / unparseable values keep the default (a 0-timeout
 *  would kill every candidate — a refuse-everything config error). */
export function reloadPrecheckTimeoutMs(fallback = DEFAULT_PRECHECK_TIMEOUT_MS): number {
  const raw = process.env.TRIBE_RELOAD_PRECHECK_TIMEOUT_MS
  if (raw === undefined) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/**
 * Validate a candidate source tree WITHOUT touching production state: spawn
 * `execPath entry ...args precheckFlag` and observe its exit. The entry's
 * precheck flag must load the full module graph (so a syntax / import-
 * resolution error crashes here, non-zero) and then exit 0 BEFORE opening any
 * DB, binding any socket, or running migrations. This is the invariant that
 * makes a reload safe: a broken source tree can never take down a working
 * process, because it fails the precheck and the re-exec is refused.
 */
export function runAdmissionPrecheck(opts: AdmissionPrecheckOpts): Promise<AdmissionResult> {
  const execPath = opts.execPath ?? process.execPath
  const precheckFlag = opts.precheckFlag ?? "--precheck"
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PRECHECK_TIMEOUT_MS
  const argv = [opts.entry, ...(opts.args ?? []), precheckFlag]

  return new Promise<AdmissionResult>((resolvePromise) => {
    let settled = false
    let timedOut = false
    let stderr = ""

    const child = spawn(execPath, argv, {
      stdio: ["ignore", "ignore", "pipe"],
      env: opts.env ?? process.env,
    })

    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill("SIGKILL")
      } catch {
        /* already gone */
      }
    }, timeoutMs)

    child.stderr?.on("data", (chunk: Buffer) => {
      // Bounded: keep the tail so a chatty candidate can't balloon memory.
      stderr = (stderr + chunk.toString()).slice(-8192)
    })

    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({
        ok: !timedOut && code === 0,
        code,
        signal,
        timedOut,
        stderr: stderr.trim(),
      })
    }

    child.on("error", (err) => {
      // spawn itself failed (execPath missing, EACCES, …) — a refusal, loudly.
      stderr = (stderr + `\n${err instanceof Error ? err.message : String(err)}`).slice(-8192)
      finish(null, null)
    })
    child.on("close", (code, signal) => finish(code, signal))
  })
}

// ---------------------------------------------------------------------------
// Design note — generation-pinned snapshots + rollback (deliberately NOT in
// this slice; recorded here per the 20703 safe-reload ladder).
//
// What ships now: debounce → admission precheck → re-exec → post-reload
// health verify. A broken candidate is refused BEFORE the working generation
// dies; a candidate that boots but reports `degraded` facts is announced
// LOUDLY (reload-degraded) but stays up — no auto-rollback.
//
// Why no auto-rollback yet:
//   1. The old generation is already gone by the time the new one can prove
//      itself: re-exec is close-then-fresh-bind (Bun cannot listen on an
//      inherited fd), so generations cannot overlap on the socket. Rolling
//      back means re-execing the PRIOR source tree — but the watch trigger
//      fired precisely because the tree CHANGED; the prior tree no longer
//      exists on disk. Real rollback therefore requires generation-pinned
//      snapshots: at each ADMITTED reload, snapshot the loaded tree keyed by
//      its code-pin SHA (e.g. `git archive <sha>` into a generations dir),
//      keep the last N, and on a red post-reload verify re-exec from the last
//      green snapshot instead of the live checkout.
//   2. Rollback without attach-idempotency trades one outage for two: every
//      re-exec (forward or back) drops all client connections and forces the
//      re-register storm through the takeover/conflict gauntlet — the primary
//      damage in the 20703 recurrence. Full blue-green (boot the candidate
//      alongside, verify for real, atomically swap the socket, keep the old
//      generation warm until green) needs attach-by-token — clients
//      re-attaching to a session token rather than a socket generation — so a
//      swap or rollback is seat-safe by construction. Until attach-by-token
//      lands, automated rollback would double the churn on exactly the
//      failure path where churn hurts most.
//
// So: verify-and-alarm now; snapshots + rollback when attach-by-token makes
// generation swaps invisible to seats.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// setupHotReload — generic source-watch + re-exec (used by the stdio adapter).
// ---------------------------------------------------------------------------

export type HotReloadOpts = {
  /** The calling module's import.meta.url */
  importMetaUrl: string
  /** Additional files to watch (beyond the auto-detected ones) */
  extraFiles?: string[]
  /** Additional directories to watch */
  extraDirs?: string[]
  /** Callback before re-exec (cleanup) */
  onReload?: () => void
  /** Broadcast activity to tribe (for watch/daemon visibility) */
  logActivity?: (type: string, content: string) => void
  /** Debounce ms (default: coalescing window from `reloadDebounceMs()`) */
  debounceMs?: number
}

/**
 * Watch source files for changes and re-exec the current process.
 * Returns a disposable that stops watching. Use with `using`.
 * Returns null if not running from source (bundled).
 */
export function setupHotReload(opts: HotReloadOpts): Disposable | null {
  const { importMetaUrl, extraFiles = [], extraDirs = [], onReload, logActivity } = opts
  const debounceMs = opts.debounceMs ?? reloadDebounceMs()

  // Only activate for source runs (file:// URLs in the repo)
  if (!importMetaUrl.startsWith("file://")) return null

  const scriptPath = new URL(importMetaUrl).pathname
  const reloadScriptName =
    scriptPath
      .split("/")
      .pop()
      ?.replace(/\.(ts|tsx)$/, "") ?? "unknown"
  const sourceDir = dirname(scriptPath)
  const libTribeDir = resolve(sourceDir, "lib/tribe")

  // Log if this is a hot-reloaded instance
  if (process.env.__TRIBE_HOT_RELOAD === "1") {
    delete process.env.__TRIBE_HOT_RELOAD
    log.info?.(`Hot-reloaded: ${reloadScriptName}`)
    logActivity?.("reload", `${reloadScriptName} hot-reloaded`)
  }

  // Detect all source files to hash
  function getSourceFiles(): string[] {
    const files = [scriptPath, ...extraFiles]
    const dirs = [libTribeDir, ...extraDirs]
    for (const dir of dirs) {
      try {
        if (existsSync(dir)) {
          for (const f of readdirSync(dir)) {
            if (f.endsWith(".ts")) files.push(resolve(dir, f))
          }
        }
      } catch {
        /* best effort */
      }
    }
    return files.sort()
  }

  function computeHash(): string {
    const hash = createHash("md5")
    for (const f of getSourceFiles()) {
      try {
        hash.update(readFileSync(f))
      } catch {
        /* missing */
      }
    }
    return hash.digest("hex").slice(0, 12)
  }

  const currentHash = computeHash()
  const watchers: FSWatcher[] = []

  // A burst of change events (a gitlink bump touching many files) coalesces
  // into ONE re-exec via the shared debouncer.
  const debouncer = createReloadDebouncer({
    windowMs: debounceMs,
    onFlush: () => {
      const newHash = computeHash()
      if (newHash === currentHash) return
      log.info?.(`Source changed (${currentHash} → ${newHash}), re-execing`)
      logActivity?.("reload", `${reloadScriptName} reloading (${currentHash} → ${newHash})`)

      // Stop watching BEFORE spawning to prevent fork bombs
      for (const w of watchers) w.close()
      watchers.length = 0

      onReload?.()

      // Spawn replacement then exit immediately
      const child = spawn(process.execPath, process.argv.slice(1), {
        stdio: "inherit",
        env: { ...process.env, __TRIBE_HOT_RELOAD: "1" },
        detached: true,
      })
      child.unref()
      process.exit(0)
    },
  })

  function onChange(filename: string | null): void {
    if (filename && !filename.endsWith(".ts") && !filename.endsWith(".tsx")) return
    debouncer.trigger()
  }

  // Watch source directory and lib/tribe
  try {
    watchers.push(watch(sourceDir, { persistent: false }, (_e, f) => onChange(f)))
  } catch {
    /* dir missing */
  }

  if (existsSync(libTribeDir)) {
    try {
      watchers.push(watch(libTribeDir, { persistent: false }, (_e, f) => onChange(f)))
    } catch {
      /* dir missing */
    }
  }

  for (const dir of extraDirs) {
    if (existsSync(dir)) {
      try {
        watchers.push(watch(dir, { persistent: false }, (_e, f) => onChange(f)))
      } catch {
        /* dir missing */
      }
    }
  }

  log.info?.(`Watching ${getSourceFiles().length} source files for hot-reload`)

  return {
    [Symbol.dispose]() {
      debouncer[Symbol.dispose]()
      for (const w of watchers) w.close()
    },
  }
}
