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
 * These handlers control the Claude Code hook protocol (exit codes, stdout
 * JSON). We must not swallow errors or rewrite output — just dispatch.
 *
 * Before forwarding, we consult the autostart config and (if configured)
 * ensure the unified tribe daemon is running. The spawn is detached +
 * unref'd so it never blocks the hook; the overall 300 ms budget guarantees
 * Claude Code never waits on us.
 *
 * km-bear.unified-daemon Phase 5d: collapsed from two parallel probes
 * (lore + tribe) to one — the unified daemon hosts both surfaces.
 */

import { createLogger, setSuppressConsole } from "loggily"
import { ensureTribeDaemonIfConfigured } from "./autostart.ts"
import { homedir } from "node:os"
import { join } from "node:path"

export type HookEvent = "session-start" | "prompt" | "session-end" | "pre-compact"

// ---------------------------------------------------------------------------
// Hook engine — pluggable host dependency (19273 standalone boundary)
// ---------------------------------------------------------------------------
//
// The hook handlers (session indexing, delta injection) and the injection
// debug recorder live in bearly's `plugins/recall` / `plugins/injection-
// envelope` — not bundled with standalone tribe. Hosts that have them point
// `TRIBE_RECALL_ENGINE_DIR` / `TRIBE_INJECTION_DEBUG_DIR` at those plugins'
// `src` directories. Standalone, `tribe hook <event>` is a defined no-op:
// the daemon autostart still runs (that part IS tribe), the recall-side
// indexing simply doesn't happen, and we say so on the loggily rail.

const log = createLogger("tribe:hook-dispatch")

type HookEngine = {
  cmdSessionStart: () => Promise<void>
  cmdSessionEnd: () => Promise<void>
  cmdHook: () => Promise<void>
}

type InjectionDebug = {
  emitInjectionDebugEvent: (event: Record<string, unknown>) => void
  installInjectionFileWriter: (path: string) => void
}

let hookEngineProbe: Promise<HookEngine | null> | undefined
async function loadHookEngine(): Promise<HookEngine | null> {
  if (hookEngineProbe !== undefined) return hookEngineProbe
  hookEngineProbe = (async () => {
    const dir = process.env.TRIBE_RECALL_ENGINE_DIR
    if (!dir) {
      log.warn?.("recall hook engine not configured (TRIBE_RECALL_ENGINE_DIR unset) — session indexing/injection skipped")
      return null
    }
    try {
      const hooks = await import(`${dir}/lib/hooks.ts`)
      return { cmdSessionStart: hooks.cmdSessionStart, cmdSessionEnd: hooks.cmdSessionEnd, cmdHook: hooks.cmdHook }
    } catch (err) {
      log.error?.(
        `recall hook engine FAILED to load from TRIBE_RECALL_ENGINE_DIR=${dir}: ${err instanceof Error ? err.message : String(err)}`,
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
    const dir = process.env.TRIBE_INJECTION_DEBUG_DIR
    if (!dir) return null
    try {
      const mod = await import(`${dir}/debug.ts`)
      return {
        emitInjectionDebugEvent: mod.emitInjectionDebugEvent,
        installInjectionFileWriter: mod.installInjectionFileWriter,
      }
    } catch (err) {
      log.error?.(
        `injection debug recorder FAILED to load from TRIBE_INJECTION_DEBUG_DIR=${dir}: ${err instanceof Error ? err.message : String(err)}`,
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
async function muzzleHookProcess(): Promise<void> {
  if (_muzzled) return
  _muzzled = true

  // Layer 1 — silence loggily's default console sink.
  setSuppressConsole(true)

  // Layer 2 — route `injection:*` events to a per-user JSONL (only when the
  // host ships the injection-envelope debug recorder).
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

export async function dispatchHook(event: HookEvent): Promise<void> {
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
    // Standalone: daemon autostart above is tribe's half and already ran;
    // the recall-side indexing half is host-supplied. Warned on the
    // loggily rail (NEVER stdout — that is the hook protocol channel).
    return
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
