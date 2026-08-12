/**
 * withConfig — parse CLI args + env, resolve socket/db/lore paths, decide quit
 * timeout and inherited fd. Pure: returns a `config` field on the daemon value.
 *
 * Owns the boundary between "command line / env" and "structured options the
 * rest of the pipe consumes." Tests may bypass `parseArgs` entirely by passing
 * a fully-formed `TribeConfig`.
 */

import { readFileSync } from "node:fs"
import { parseArgs } from "node:util"
import { createLogger } from "loggily"
import { resolveSocketPath } from "tribe-wire/lib/socket"
import { parseTribeArgs, resolveDbPath } from "tribe-wire/lib/config"
import { resolveRecallDbPath } from "../../../../../plugins/claude/recall/lib/config.ts"
import { resolveSummarizerMode, type SummarizerMode } from "../../../../../plugins/claude/recall/lib/summarizer.ts"
import type { BaseTribe } from "./base.ts"

const log = createLogger("tribe:config")

/** Where the effective idle-quit value came from. Carried in the config so the
 * startup disclosure names the surface a reader must act on — the 2026-08-11
 * incident was a log line naming a knob nothing read. */
export type IdleQuitSource = "flag" | "deprecated-flag" | "env" | "hab-managed" | "default"

export interface TribeConfig {
  readonly socketPath: string
  readonly dbPath: string
  /** True only for the default XDG path, whose legacy migration precedes open. */
  readonly migrateLegacyDb?: boolean
  readonly recallDbPath: string
  /** Idle-quit delay in seconds. -1 ("never") disables auto-quit, 0 quits immediately on idle. */
  readonly idleQuitAfterSec: number
  /** Which surface set idleQuitAfterSec — see IdleQuitSource. */
  readonly idleQuitSource: IdleQuitSource
  /** Inherit an already-bound listening fd (set by the SIGHUP re-exec). */
  readonly inheritFd: number | null
  readonly focusPollMs: number
  readonly summaryPollMs: number
  readonly summarizerMode: SummarizerMode
  readonly recallEnabled: boolean
  /** Optional capability for unauthenticated operator-only mutating RPCs. */
  readonly operatorCapability?: string | null
}

export interface WithConfig {
  readonly config: TribeConfig
}

export interface ConfigOpts {
  /** Skip parseArgs and use this config directly (tests). */
  override?: TribeConfig
  /** Argv to parse (defaults to process.argv.slice(2)). */
  argv?: string[]
}

/**
 * Parse an idle-quit duration. Accepted forms:
 *   - `"never"` → -1 (never idle-quit)
 *   - bare integer seconds: `"1800"`; negative integers keep the historical
 *     "any negative disables" semantics (`--quit-timeout -1` in the field)
 *   - unit-suffixed durations: `"90s"`, `"30m"`, `"6h"`
 *
 * Anything else throws — an unparseable value silently becoming NaN made the
 * idle countdown arithmetic all-false, i.e. a daemon that never quits with no
 * record of deciding that. Fail loud at the boundary instead.
 */
export function parseIdleQuitAfterSec(raw: string, surface: string): number {
  const value = raw.trim()
  if (value.toLowerCase() === "never") return -1
  if (/^-\d+$/.test(value)) return parseInt(value, 10)
  const match = value.match(/^(\d+)(s|m|h)?$/)
  if (match) {
    const n = parseInt(match[1] as string, 10)
    switch (match[2]) {
      case "m":
        return n * 60
      case "h":
        return n * 3600
      default:
        return n
    }
  }
  throw new Error(
    `${surface} must be seconds ("1800"), a duration ("90s", "30m", "6h"), or "never"; received ${JSON.stringify(raw)}`,
  )
}

/**
 * Resolve the idle-quit knob from its four surfaces, most explicit first:
 *
 *   1. `--idle-quit-after <duration|never>` — the canonical flag.
 *   2. `--quit-timeout <seconds>` — hidden deprecated alias (renamed
 *      2026-08-12: the old name said neither what quits nor when). hab wire
 *      supervise.json materialized in the field still passes
 *      `--quit-timeout -1`; it must keep parsing. One-line notice when used.
 *   3. `TRIBE_AUTOQUIT_ON_IDLE` env.
 *   4. No explicit config: hab-supervised daemons (HAB_SERVICE_NAME present)
 *      never idle-quit — a seat-relaunch sweep empties every connection at
 *      once and is indistinguishable from idleness, and hab counts the clean
 *      exit as a service failure (the 2026-08-11/12 rail outages). Standalone
 *      and bridge-minted daemons keep the 1800s default so an abandoned
 *      daemon still retires itself.
 */
export function resolveIdleQuit(input: {
  idleQuitAfter?: string
  quitTimeout?: string
  env: { TRIBE_AUTOQUIT_ON_IDLE?: string; HAB_SERVICE_NAME?: string }
}): { idleQuitAfterSec: number; idleQuitSource: IdleQuitSource } {
  if (input.idleQuitAfter !== undefined) {
    return { idleQuitAfterSec: parseIdleQuitAfterSec(input.idleQuitAfter, "--idle-quit-after"), idleQuitSource: "flag" }
  }
  if (input.quitTimeout !== undefined) {
    const idleQuitAfterSec = parseIdleQuitAfterSec(input.quitTimeout, "--quit-timeout")
    log.warn?.(`--quit-timeout is deprecated; use --idle-quit-after <duration|never> (parsed as before this run)`)
    return { idleQuitAfterSec, idleQuitSource: "deprecated-flag" }
  }
  if (input.env.TRIBE_AUTOQUIT_ON_IDLE !== undefined) {
    return {
      idleQuitAfterSec: parseIdleQuitAfterSec(input.env.TRIBE_AUTOQUIT_ON_IDLE, "TRIBE_AUTOQUIT_ON_IDLE"),
      idleQuitSource: "env",
    }
  }
  if (typeof input.env.HAB_SERVICE_NAME === "string" && input.env.HAB_SERVICE_NAME.trim() !== "") {
    return { idleQuitAfterSec: -1, idleQuitSource: "hab-managed" }
  }
  return { idleQuitAfterSec: 1800, idleQuitSource: "default" }
}

function readOperatorCapabilityFromInheritedFd(fdRaw: string | undefined): string | null {
  if (fdRaw === undefined) return null
  const fd = Number(fdRaw)
  if (!Number.isSafeInteger(fd) || fd < 3) {
    throw new Error(`TRIBE_OPERATOR_CAPABILITY_FD must name an inherited fd >= 3, received ${JSON.stringify(fdRaw)}`)
  }
  const capability = readFileSync(fd, "utf8").trim()
  if (!capability) throw new Error("TRIBE_OPERATOR_CAPABILITY_FD contained an empty operator capability")
  return capability
}

export function withConfig<T extends BaseTribe>(opts: ConfigOpts = {}): (t: T) => T & WithConfig {
  return (t) => {
    if (opts.override) return { ...t, config: opts.override }

    const { values: daemonArgs } = parseArgs({
      args: opts.argv,
      options: {
        socket: { type: "string" },
        db: { type: "string" },
        fd: { type: "string" },
        // Canonical idle-quit flag. Resolution order and the deprecated alias
        // live in resolveIdleQuit above — one authority, tested directly.
        "idle-quit-after": { type: "string" },
        // Hidden deprecated alias for --idle-quit-after. Field supervise.json
        // still passes `--quit-timeout -1`; it must keep parsing.
        "quit-timeout": { type: "string" },
        foreground: { type: "boolean", default: false },
        "recall-db": { type: "string" },
        "focus-poll-ms": { type: "string", default: process.env.TRIBE_FOCUS_POLL_MS ?? "60000" },
        "summary-poll-ms": { type: "string", default: process.env.TRIBE_SUMMARY_POLL_MS ?? "120000" },
        "summarizer-model": { type: "string", default: process.env.TRIBE_SUMMARIZER_MODEL ?? "off" },
        "no-lore": { type: "boolean", default: false },
      },
      strict: false,
    })

    const tribeArgs = parseTribeArgs()
    if (daemonArgs.db) tribeArgs.db = daemonArgs.db as string
    const migrateLegacyDb = tribeArgs.db === undefined

    const idleQuit = resolveIdleQuit({
      idleQuitAfter: daemonArgs["idle-quit-after"] as string | undefined,
      quitTimeout: daemonArgs["quit-timeout"] as string | undefined,
      env: {
        TRIBE_AUTOQUIT_ON_IDLE: process.env.TRIBE_AUTOQUIT_ON_IDLE,
        HAB_SERVICE_NAME: process.env.HAB_SERVICE_NAME,
      },
    })

    const config: TribeConfig = {
      socketPath: resolveSocketPath(daemonArgs.socket as string | undefined),
      dbPath: String(resolveDbPath(tribeArgs, { migrateLegacy: false })),
      migrateLegacyDb,
      recallDbPath: resolveRecallDbPath(daemonArgs["recall-db"] as string | undefined),
      idleQuitAfterSec: idleQuit.idleQuitAfterSec,
      idleQuitSource: idleQuit.idleQuitSource,
      inheritFd: daemonArgs.fd ? parseInt(String(daemonArgs.fd), 10) : null,
      focusPollMs: Math.max(100, parseInt(String(daemonArgs["focus-poll-ms"]), 10) || 60_000),
      summaryPollMs: Math.max(500, parseInt(String(daemonArgs["summary-poll-ms"]), 10) || 120_000),
      summarizerMode: resolveSummarizerMode(String(daemonArgs["summarizer-model"])),
      recallEnabled: !daemonArgs["no-lore"],
      operatorCapability: readOperatorCapabilityFromInheritedFd(process.env.TRIBE_OPERATOR_CAPABILITY_FD),
    }

    return { ...t, config }
  }
}
