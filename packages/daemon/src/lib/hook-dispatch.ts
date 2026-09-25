/**
 * Tribe hook dispatch — thin wrapper around recall's hook handlers.
 *
 * `tribe hook <event>` is the unified entry point for Claude Code hooks.
 * It replaces the scattered `recall session-start` / `recall session-end` /
 * `recall hook` commands while calling through to the same functions so that
 * behavior (sentinel files, daemon registration, incremental indexing, delta
 * injection) is preserved byte-for-byte.
 *
 * Events:
 *   session-start — SessionStart hook (reads stdin JSON: session_id, cwd, ...)
 *   prompt        — UserPromptSubmit hook (reads stdin JSON: prompt, ...)
 *   session-end   — SessionEnd hook
 *   pre-compact   — PreCompact hook (currently a no-op passthrough to cmdHook)
 *
 * Options, after the event:
 *   --vault-db <path> — the km vault the in-process recall searches, bound through recall's bindVaultDb
 *                       (25149 a3). A prompt the daemon answers searches the daemon's own `--vault-db`.
 *
 * The engine's surface is its lib files. A host loads the engine by its directory and reaches it only through
 * lib/ (here lib/hooks.ts; the daemon uses lib/search.ts), never its internals under history/, which may move
 * without a host noticing. When a host needs an internal, lib/ re-exports it, as bindVaultDb is.
 *
 * These handlers control the Claude Code hook protocol (exit codes, stdout
 * JSON). We must not swallow errors or rewrite output — just dispatch.
 *
 * Before forwarding, we consult the autostart config and (if configured)
 * ensure the unified tribe daemon is running. The stable standalone owner is
 * detached + unref'd while the daemon remains its child, and that check has
 * its own 300 ms budget (autostart.ts). The prompt hook as a whole is bounded
 * by its recall: a 1.0 s target and a 1.5 s wall, both stated in
 * tribe-recall's history/recall-budget.ts with their measurements
 * (@ag/tribe/25071 row 2; the prompt hook measured 2 to 4 s against a 300 ms
 * figure once written here).
 *
 * km-bear.unified-daemon Phase 5d: collapsed from two parallel probes
 * (lore + tribe) to one — the unified daemon hosts both surfaces.
 */

import { createLogger, setSuppressConsole } from "loggily"
import { ensureTribeDaemonIfConfigured } from "./autostart.ts"
import { existsSync } from "node:fs"
import { resolveVaultDbFlag } from "../../../recall/src/lib/vault-db.ts"
import { homedir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"

export type HookEvent = "session-start" | "prompt" | "session-end" | "pre-compact"

// ---------------------------------------------------------------------------
// Hook engine — in-repo since the 19273 move (packages/recall +
// packages/injection-envelope)
// ---------------------------------------------------------------------------
//
// The hook handlers (session indexing, delta injection) and the injection
// debug recorder ship with this repo. They still load lazily so the hook
// process stays light, and `TRIBE_RECALL_ENGINE_DIR` /
// `TRIBE_INJECTION_DEBUG_DIR` remain override seams for forks. A load
// failure is a real error, reported on the loggily rail (NEVER stdout —
// that is the hook protocol channel) — the hook then degrades to
// autostart-only rather than crashing the Claude session.

const log = createLogger("tribe:hook-dispatch")

// Typed off the REAL in-repo modules (`typeof import` is type-only; runtime
// loading stays lazy + dynamic below so the hook process starts light).
//
// Deliberately excludes `cmdRemember`: it can make a real synchronous LLM
// call + `git log` spawn + retro-bead creation with no per-day lock, so it
// stays manual-only (`recall remember` / `recall summarize`) rather than
// hook-dispatched. See the docstring on `cmdRemember`
// (packages/recall/src/lib/hooks.ts) and /hh/docs/reference/tribe/recall.md § "Automatic
// injection" before adding it here — this exclusion is pinned by
// hook-dispatch.test.ts.
type HookEngine = {
  cmdSessionStart: (typeof import("../../../recall/src/lib/hooks.ts"))["cmdSessionStart"]
  cmdSessionEnd: (typeof import("../../../recall/src/lib/hooks.ts"))["cmdSessionEnd"]
  cmdHook: (typeof import("../../../recall/src/lib/hooks.ts"))["cmdHook"]
  bindVaultDb: (typeof import("../../../recall/src/lib/hooks.ts"))["bindVaultDb"]
}

type InjectionDebug = {
  emitInjectionDebugEvent: (typeof import("../../../injection-envelope/src/debug.ts"))["emitInjectionDebugEvent"]
  installInjectionFileWriter: (typeof import("../../../injection-envelope/src/debug.ts"))["installInjectionFileWriter"]
}

/** In-repo engine is the default since the 19273 move; the env var is an override seam for forks/experiments only. */
function engineDir(): string {
  return process.env.TRIBE_RECALL_ENGINE_DIR ?? new URL("../../../recall/src", import.meta.url).pathname
}

let hookEngineProbe: Promise<HookEngine | null> | undefined
async function loadHookEngine(): Promise<HookEngine | null> {
  if (hookEngineProbe !== undefined) return hookEngineProbe
  hookEngineProbe = (async () => {
    const dir = engineDir()
    try {
      const hooks = await (import(`${dir}/lib/hooks.ts`) as Promise<typeof import("../../../recall/src/lib/hooks.ts")>)
      return {
        cmdSessionStart: hooks.cmdSessionStart,
        cmdSessionEnd: hooks.cmdSessionEnd,
        cmdHook: hooks.cmdHook,
        bindVaultDb: hooks.bindVaultDb,
      }
    } catch (err) {
      log.error?.(
        `recall hook engine FAILED to load from ${dir}${process.env.TRIBE_RECALL_ENGINE_DIR ? " (TRIBE_RECALL_ENGINE_DIR override)" : " (in-repo default)"}: ${err instanceof Error ? err.message : String(err)} — session indexing/injection skipped`,
      )
      return null
    }
  })()
  return hookEngineProbe
}

let injectionDebugProbe: Promise<InjectionDebug | null> | undefined
async function loadInjectionDebug(): Promise<InjectionDebug | null> {
  if (injectionDebugProbe !== undefined) return injectionDebugProbe
  injectionDebugProbe = (async () => {
    // In-repo recorder is the default since the 19273 move; the env var is an
    // override seam for forks/experiments only.
    const dir =
      process.env.TRIBE_INJECTION_DEBUG_DIR ?? new URL("../../../injection-envelope/src", import.meta.url).pathname
    try {
      const mod = await (import(`${dir}/debug.ts`) as Promise<
        typeof import("../../../injection-envelope/src/debug.ts")
      >)
      return {
        emitInjectionDebugEvent: mod.emitInjectionDebugEvent,
        installInjectionFileWriter: mod.installInjectionFileWriter,
      }
    } catch (err) {
      log.error?.(
        `injection debug recorder FAILED to load from ${dir}${process.env.TRIBE_INJECTION_DEBUG_DIR ? " (TRIBE_INJECTION_DEBUG_DIR override)" : " (in-repo default)"}: ${err instanceof Error ? err.message : String(err)}`,
      )
      return null
    }
  })()
  return injectionDebugProbe
}

/**
 * One-shot, idempotent muzzle of console output for the hook process.
 *
 * Why: when a Claude Code hook writes anything to stdout/stderr, the
 * harness captures that text and surfaces it to the model in the next
 * turn as `<system-reminder>UserPromptSubmit hook success: <captured></system-reminder>`.
 * Transcript-shaped captured text inside that envelope has triggered the
 * assistant's autocatalytic role-prefix hallucination
 * (`Human: <system-reminder>…`). Upstream issue:
 * https://github.com/anthropics/claude-code/issues/50972.
 *
 * Mitigation — two layers, both idempotent and routed through loggily:
 *
 *   1. `setSuppressConsole(true)` silences loggily's default console
 *      sink while leaving `addWriter({ ns: "injection:*" }, …)` and
 *      explicit pipeline writers untouched.
 *   2. `installInjectionFileWriter(path)` routes injection:* events to
 *      a per-user JSONL so observability is preserved without going
 *      anywhere Claude Code can read.
 *
 * Discipline contract: every other module in the hook code path
 * (`@bearly/recall`, `tribe/autostart`, `tribe/rpc`, …) MUST use a
 * loggily logger for diagnostic output, never raw `console.error` or
 * `process.stderr.write`. Layer 1 only catches loggily-routed traffic;
 * stragglers leak. The only sanctioned `console.log` call in this code
 * path is the hook's JSON response written by `cmdHook` /
 * `cmdSessionStart` / `cmdSessionEnd`. If you find a raw `console.*` in
 * a hook code path, route it through loggily — don't intercept here.
 */
let _muzzled = false
export async function muzzleHookProcess(): Promise<void> {
  if (_muzzled) return
  _muzzled = true

  // Layer 1 — silence loggily's default console sink.
  setSuppressConsole(true)

  // Layer 2 — route `injection:*` events to a per-user JSONL via the in-repo
  // injection-envelope debug recorder.
  const injection = await loadInjectionDebug()
  if (!injection) return
  const path =
    process.env.INJECTION_DEBUG_LOG ??
    process.env.LOGGILY_FILE ??
    join(homedir(), ".local", "share", "bearly", "injection.jsonl")
  try {
    injection.installInjectionFileWriter(path)
  } catch (err) {
    // The injection-envelope debug recorder owns its own /tmp fallback;
    // record the error there for later forensics. Never write to
    // stderr/stdout — that's the bug we're fixing.
    injection.emitInjectionDebugEvent({
      source: "hook-dispatch",
      action: "error",
      reason: "installInjectionFileWriter_failed",
      errorMessage: err instanceof Error ? err.message : String(err),
    })
  }
}

/** The options a hook line carries after its event. */
export interface HookArgs {
  /** `--vault-db <path>`: the vault the prompt hook's in-process recall searches (25149 a3). */
  readonly vaultDb?: string
}

/**
 * Parse the options after `hook <event>`. Strict: an unknown option, an empty `--vault-db` (what a failed
 * `$(…)` substitution passes) or a `--vault-db` naming no file is an error the caller prints, never an unbound
 * vault.
 */
export function parseHookArgs(
  argv: readonly string[],
  exists: (path: string) => boolean = existsSync,
): HookArgs | { readonly error: string } {
  let values: { "vault-db"?: string }
  try {
    ;({ values } = parseArgs({
      args: [...argv],
      options: { "vault-db": { type: "string" } },
      strict: true,
      allowPositionals: false,
    }))
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
  try {
    const vaultDb = resolveVaultDbFlag(values["vault-db"], exists)
    return vaultDb === null ? {} : { vaultDb }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

export async function dispatchHook(event: HookEvent, args: HookArgs = {}): Promise<void> {
  // Muzzle BEFORE anything else — autostart, recall handlers, daemon
  // RPCs, plugin loading all use loggily and would otherwise leak text
  // into the hook's stdout/stderr. See muzzleHookProcess docstring.
  await muzzleHookProcess()

  // Fire-and-check autostart before the real handler runs. Errors are
  // swallowed internally — hooks must never crash here.
  try {
    await ensureTribeDaemonIfConfigured()
  } catch {
    /* never block the hook on autostart failure */
  }

  const engine = await loadHookEngine()
  if (!engine) {
    // Engine load failed (in-repo default or a broken override) — the
    // autostart above already ran; the indexing half degrades. The error
    // went to the loggily rail (NEVER stdout — the hook protocol channel).
    return
  }
  // Recall's own binding, carried through from the call line — the vault is never found from the cwd.
  if (args.vaultDb !== undefined) {
    if (typeof engine.bindVaultDb !== "function") {
      throw new Error(
        `tribe hook: the recall engine at ${engineDir()} has no bindVaultDb export (it predates --vault-db, 25149 a3)`,
      )
    }
    engine.bindVaultDb(args.vaultDb)
  }

  switch (event) {
    case "session-start":
      await engine.cmdSessionStart()
      return
    case "session-end":
      await engine.cmdSessionEnd()
      return
    case "prompt":
    case "pre-compact":
      // Both feed stdin JSON to the UserPromptSubmit-style handler. cmdHook
      // reads `hook_event_name` from stdin and routes accordingly.
      await engine.cmdHook()
      return
  }
}
