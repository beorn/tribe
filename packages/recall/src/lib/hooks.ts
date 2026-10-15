/**
 * Hook handlers for UserPromptSubmit and SessionEnd.
 * Called by Claude Code hooks, not directly by users.
 *
 * Diagnostic output goes through loggily — never `console.error` /
 * `process.stderr.write`. Hook stdout/stderr is captured by Claude Code
 * and surfaced to the model as `<system-reminder>UserPromptSubmit hook
 * success: <captured></system-reminder>`, and transcript-shaped captured
 * text triggers an autocatalytic role-prefix hallucination
 * (`Human: <system-reminder>…`). The hook entry point in
 * `tools/lib/tribe/hook-dispatch.ts` calls `setSuppressConsole(true)` and
 * installs a JSONL writer for `injection:*`, plus a generic writer for
 * `recall:*` here. See that file's docstring for the full mitigation.
 *
 * `console.log` is the *only* sanctioned stdout writer in this file —
 * it's the hook's JSON response channel, read by Claude Code via
 * `hookSpecificOutput`.
 *
 * The one exception to the stderr ban is `reportHookFailure`, called only
 * on a nonzero exit. Nothing is captured into the next turn when the hook
 * fails; Claude Code shows that stderr to the operator instead, and an
 * empty one reads as `Failed with non-blocking status code: No stderr
 * output`. See its docstring.
 */

import * as path from "path"
import * as os from "os"
import * as fs from "fs"
import { createLogger, drainOutput } from "loggily"
import { hookRecall, type HookResult } from "../history/recall"
import { summarizeUnprocessedDays } from "./summarize-daily"
import { roundSteps, timeStepAsync } from "./inject-core"
import { createDeadlineRecall } from "./recall-deadline.ts"
import { withDaemonCall } from "../../../../plugins/claude/recall/lib/socket.ts"
import { resolveSocketPath } from "../../../wire/src/paths.ts"
import { TRIBE_METHODS, RECALL_PROTOCOL_VERSION } from "../../../../plugins/claude/recall/lib/rpc.ts"
// Route every UserPromptSubmit emission through the envelope so the unified
// activity log catches it (km-tribe.activity-log phase 2).
import { emitHookJson as envelopeEmitHookJson } from "../../../injection-envelope/src/emit.ts"
import { flushInjectionFileWriters } from "../../../injection-envelope/src/debug.ts"
import { getVaultDb, getVaultDbPath, searchVault } from "../history/vault-fts.ts"
import { runBoundedProcessCommand, type BoundedProcessBounds } from "./bounded-process.ts"

/** The call-line vault binding (`tribe hook <event> --vault-db`), for the dispatcher that loads this by path (25149 a3). */
export { bindVaultDb } from "../history/vault-fts.ts"

// Loggily namespaces — kept narrow so a reader can grep `producer` /
// namespace in the JSONL and attribute lines to the right hook event.
const sessionStartLog = createLogger("recall:hook:session-start")
const sessionEndLog = createLogger("recall:hook:session-end")
const hookLog = createLogger("recall:hook:prompt")
const rememberLog = createLogger("recall:hook:remember")
const preCompactLog = createLogger("recall:hook:pre-compact")

/**
 * The one sanctioned stderr writer in this file, for FAILING exits only.
 *
 * The muzzle described in the module docstring silences loggily's console
 * sink for the whole hook process, so a `hookLog.error` before a nonzero
 * exit reaches nobody: Claude Code reports the hook as
 * `UserPromptSubmit hook error — Failed with non-blocking status code: No
 * stderr output` and the reason is lost. NO SILENT ERRORS — name the hook
 * and the reason on the way out.
 *
 * Only the nonzero paths call this. On exit 0 the harness folds captured
 * hook output into the next turn as
 * `<system-reminder>UserPromptSubmit hook success: …</system-reminder>`,
 * which is the hallucination the muzzle exists to prevent; successful
 * skips stay on the loggily rail with the other skip reasons.
 *
 * `writeSync` rather than `process.stderr.write`: the caller exits as soon
 * as `drainOutput()` settles, and a queued async write can be discarded.
 */
function reportHookFailure(event: string, reason: unknown): void {
  const text = reason instanceof Error ? reason.message : String(reason)
  try {
    fs.writeSync(2, `tribe hook ${event}: ${text}\n`)
  } catch {
    // stderr is gone (closed pipe) — the exit status still carries the failure.
  }
}

// ============================================================================
// Session sentinel (written by hook, read by `bun recall` subprocesses)
// ============================================================================

const SENTINEL_DIR = path.join(os.homedir(), ".claude", "bearly-sessions")

export interface SessionSentinel {
  claudePid: number
  sessionId: string
  transcriptPath?: string
  cwd: string
  ts: number
}

export function writeSessionSentinel(sentinel: Omit<SessionSentinel, "ts">): void {
  try {
    fs.mkdirSync(SENTINEL_DIR, { recursive: true })
    const payload: SessionSentinel = { ...sentinel, ts: Date.now() }
    const file = path.join(SENTINEL_DIR, `pid-${sentinel.claudePid}.json`)
    fs.writeFileSync(file, JSON.stringify(payload))

    // Opportunistic cleanup: drop sentinels older than 24h
    try {
      const entries = fs.readdirSync(SENTINEL_DIR)
      const cutoff = Date.now() - 24 * 60 * 60 * 1000
      for (const name of entries) {
        if (!name.startsWith("pid-") || !name.endsWith(".json")) continue
        const p = path.join(SENTINEL_DIR, name)
        const stat = fs.statSync(p)
        if (stat.mtimeMs < cutoff) fs.unlinkSync(p)
      }
    } catch {
      /* best effort */
    }
  } catch {
    // Sentinel writing is best-effort — must never block the hook.
  }
}

// ============================================================================
// SessionStart hook — writes the sentinel ONCE per session
// ============================================================================

/**
 * Claude Code fires SessionStart once when a session begins, with stdin JSON
 * including session_id, transcript_path, and cwd. We use it to write the
 * sentinel file that `bun recall` will read later, without needing to
 * piggyback on every UserPromptSubmit hook call.
 *
 * Install in .claude/settings.json:
 *   {
 *     "hooks": {
 *       "SessionStart": [{
 *         "matcher": "",
 *         "hooks": [{"type": "command", "command": "tribe hook session-start"}]
 *       }]
 *     }
 *   }
 */
export async function cmdSessionStart(): Promise<void> {
  const startTime = Date.now()
  try {
    const stdin = await readStdin()
    let input: { session_id?: string; transcript_path?: string; cwd?: string }
    try {
      input = JSON.parse(stdin) as typeof input
    } catch (e) {
      sessionStartLog.warn?.("invalid JSON", { error: String(e) })
      // oxlint-disable-next-line typescript/return-await -- drain failure must bypass this catch
      return drainOutput().then(() => process.exit(0)) // don't block session startup
    }

    if (!input.session_id || !input.cwd) {
      sessionStartLog.warn?.("missing session_id or cwd — skipping", {
        has_session_id: Boolean(input.session_id),
        has_cwd: Boolean(input.cwd),
      })
      // oxlint-disable-next-line typescript/return-await -- drain failure must bypass this catch
      return drainOutput().then(() => process.exit(0))
    }

    const claudePid = process.ppid
    const sessionId = input.session_id
    const transcriptPath = input.transcript_path
    const cwd = input.cwd

    // Always write the sentinel — it's the fallback path when the daemon is
    // down (session-context.ts still reads it). Fast and never blocks.
    writeSessionSentinel({ claudePid, sessionId, transcriptPath, cwd })

    // Best-effort register with lore daemon. Non-blocking: if we can't reach
    // the daemon in 1s we give up and rely on the sentinel.
    let daemonStatus = "skipped"
    if (process.env.TRIBE_NO_DAEMON !== "1") {
      daemonStatus = await registerWithRecallDaemon({ claudePid, sessionId, transcriptPath, cwd })
    }

    // No index refresh here (@ag/tribe/25071 row 4): indexing runs outside the hooks, never from a seat's session
    // lifecycle. A hook-spawned indexer was a second writer into the live index from every seat.

    sessionStartLog.info?.("ok", {
      claude_pid: claudePid,
      session: sessionId.slice(0, 8),
      sentinel: "ok",
      daemon: daemonStatus,
      elapsed_ms: Date.now() - startTime,
    })
  } catch (e) {
    sessionStartLog.error?.(e instanceof Error ? e : new Error(String(e)), "session-start handler error")
    // Never fail — session startup must not be blocked
  }
}

// ============================================================================
// SessionEnd hook — drains stdin and logs; it never writes the index
// ============================================================================

/**
 * Claude Code fires SessionEnd when a session ends. The session's new JSONL
 * content reaches the index through indexing that runs outside the hooks,
 * never through this hook (@ag/tribe/25071 row 4).
 *
 * Install in .claude/settings.json:
 *   {
 *     "hooks": {
 *       "SessionEnd": [{
 *         "matcher": "",
 *         "hooks": [{"type": "command", "command": "tribe hook session-end"}]
 *       }]
 *     }
 *   }
 */
export async function cmdSessionEnd(): Promise<void> {
  const startTime = Date.now()
  try {
    // Drain stdin so Claude Code doesn't hang on the pipe, but we don't need it.
    try {
      await readStdin()
    } catch {
      /* best effort */
    }
    sessionEndLog.info?.("ok", {
      elapsed_ms: Date.now() - startTime,
    })
  } catch (e) {
    sessionEndLog.error?.(e instanceof Error ? e : new Error(String(e)), "session-end handler error")
  }
}

/**
 * Register the current session with the tribe daemon. Returns a short status
 * string for the log line. Never throws — daemon registration is best-effort
 * and the sentinel file is the ground-truth fallback.
 */
async function registerWithRecallDaemon(input: {
  claudePid: number
  sessionId: string
  transcriptPath?: string
  cwd: string
}): Promise<string> {
  const outcome = await withDaemonCall(
    { socketPath: resolveSocketPath(), deadlineMs: 1500, callTimeoutMs: 1000 },
    async (client) => {
      await client.call(TRIBE_METHODS.hello, {
        clientName: "recall-hook",
        clientVersion: "0.1.0",
        protocolVersion: RECALL_PROTOCOL_VERSION,
      })
      await client.call(TRIBE_METHODS.sessionRegister, input)
    },
  )
  switch (outcome.kind) {
    case "ok":
      return "ok"
    case "no-daemon":
      return "no-daemon"
    case "timeout":
      return "err(timeout)"
    case "error":
      return `err(${outcome.message})`
  }
}

// ============================================================================
// Stdin reader
// ============================================================================

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString("utf8")
}

// ============================================================================
// Hook command — UserPromptSubmit
// ============================================================================

/**
 * A step skipped rather than waited on is said out loud, never silent (@ag/tribe/25071): today the project-source
 * refresh, when the index writer or SQLite's write lock is held. Recall ran on the library path.
 */
/** The recall calls a wall can cut (inject-core.ts): call A on the vault, call B on the prompt. */
const WALL_CUT_STEPS = ["recall_vault", "recall"] as const

/**
 * What the hook's own row says about one decision (29480): why nothing was injected, what was searched in how long,
 * and which recall call the wall cut. This timed recall:hook:prompt row is the authoritative one; the envelope's
 * injection:skip event is its debug stream, untimed.
 */
export function hookDecisionFields(result: HookResult): Record<string, unknown> {
  const skippedSteps = result.skippedSteps ?? {}
  const wallCut = WALL_CUT_STEPS.filter((step) => skippedSteps[step] !== undefined)
  return {
    ...(result.emptyReason === undefined ? {} : { empty_reason: result.emptyReason }),
    ...(result.searched === undefined ? {} : { searched: result.searched }),
    ...(wallCut.length === 0 ? {} : { wall_cut: wallCut }),
    ...(Object.keys(skippedSteps).length === 0 ? {} : { skipped_steps: skippedSteps }),
  }
}

function warnSkippedSteps(
  skippedSteps: Record<string, string> | undefined,
  path: "library",
  startTime: number,
  steps: Record<string, number>,
): void {
  if (!skippedSteps || Object.keys(skippedSteps).length === 0) return
  hookLog.warn?.("step skipped rather than waited on", {
    path,
    skipped_steps: skippedSteps,
    elapsed_ms: Date.now() - startTime,
    steps: roundSteps(steps),
  })
}

export async function cmdHook(): Promise<void> {
  // Return drain promises so failures bypass the hook catch and remain nonzero.
  const startTime = Date.now()
  // Each step's wall time, carried on every row below, so a slow run names its slow step (@ag/tribe/25071 row 1).
  const steps: Record<string, number> = {}
  let sessionId: string | undefined
  try {
    const stdin = await timeStepAsync(steps, "stdin", () => readStdin())
    let input: {
      prompt?: string
      session_id?: string
      transcript_path?: string
      cwd?: string
      hook_event_name?: string
    }
    try {
      input = JSON.parse(stdin) as {
        prompt?: string
        session_id?: string
        transcript_path?: string
        cwd?: string
        hook_event_name?: string
      }
    } catch (e) {
      hookLog.error?.(e instanceof Error ? e : new Error(String(e)), "FATAL: invalid JSON on stdin", {
        elapsed_ms: Date.now() - startTime,
        steps: roundSteps(steps),
        stdin_preview: stdin.slice(0, 200),
      })
      reportHookFailure("prompt", `invalid JSON on stdin: ${e instanceof Error ? e.message : String(e)}`)
      // oxlint-disable-next-line typescript/return-await -- drain failure must bypass this catch
      return drainOutput().then(() => process.exit(1))
    }

    sessionId = input.session_id

    // Log start immediately so that if Claude Code kills this hook at 30s timeout,
    // the run appears in the log as started and never finished (25304).
    hookLog.info?.("start", {
      session: sessionId,
      start_time: startTime,
    })
    flushInjectionFileWriters()

    // Write a sentinel file keyed by the parent Claude Code PID so that
    // subsequent `bun recall` invocations (from the same session) can look
    // up the current session_id reliably — without depending on env vars
    // Claude Code doesn't set, or mtime heuristics that break under
    // parallel sessions. Hook runs as a direct child of claude, so
    // process.ppid = claude PID.
    if (input.session_id && input.cwd) {
      writeSessionSentinel({
        claudePid: process.ppid,
        sessionId: input.session_id,
        transcriptPath: input.transcript_path,
        cwd: input.cwd,
      })
    }

    const prompt = input.prompt
    if (!prompt) {
      // A hook must not block a user's prompt over its own input shape, so the exit stays 0 — but it is never a
      // silent exit 0 of nothing: the event the payload named is written to the daemon's log (@cto, 22967).
      hookLog.warn?.("cmdHook: no prompt in stdin — naming the event rather than exiting 0 silently", {
        event: input.hook_event_name ?? "unknown",
        session: sessionId,
        elapsed_ms: Date.now() - startTime,
        steps: roundSteps(steps),
      })
      // oxlint-disable-next-line typescript/return-await -- drain failure must bypass this catch
      return drainOutput().then(() => process.exit(0))
    }

    // 25298: No daemon serves prompt hooks — a persistent wire loop must not
    // run synchronous bun:sqlite FTS, which would block the entire fleet's
    // message bus. Recall runs directly via the in-process Worker under
    // createDeadlineRecall below.

    // A hard wall clock on recall, run in a Worker this process leaves behind when it exits (@ag/tribe/25071 stopgap).
    const deadlineRecall = createDeadlineRecall()
    let result: Awaited<ReturnType<typeof hookRecall>>
    try {
      result = await hookRecall(prompt, { steps, recall: deadlineRecall })
    } finally {
      deadlineRecall.close()
    }
    const elapsed = Date.now() - startTime
    warnSkippedSteps(result.skippedSteps, "library", startTime, steps)
    if (result.skipped) {
      hookLog.info?.("library skipped", {
        session: sessionId,
        reason: result.reason,
        ...hookDecisionFields(result),
        elapsed_ms: elapsed,
        steps: roundSteps(steps),
        prompt_preview: prompt.slice(0, 60),
      })
      // oxlint-disable-next-line typescript/return-await -- drain failure must bypass this catch
      return drainOutput().then(() => process.exit(0))
    }
    const additionalContext = result.hookOutput?.hookSpecificOutput.additionalContext ?? ""
    hookLog.info?.("library ok", {
      session: sessionId,
      context_len: additionalContext.length,
      ...hookDecisionFields(result),
      elapsed_ms: elapsed,
      steps: roundSteps(steps),
      prompt_preview: prompt.slice(0, 60),
    })
    // The hook's JSON response: console.log is the sanctioned channel.
    console.log(envelopeEmitHookJson("UserPromptSubmit", additionalContext, prompt))
    // Exit, never wait for the loop to drain: a recall Worker left behind at its deadline can sit in one native SQLite
    // call and would hold this process open past Claude Code's kill (@ag/tribe/25071 stopgap).
    // oxlint-disable-next-line typescript/return-await -- drain failure must bypass this catch
    return drainOutput().then(() => process.exit(0))
  } catch (e) {
    const elapsed = Date.now() - startTime
    hookLog.error?.(e instanceof Error ? e : new Error(String(e)), "FATAL: unhandled error", {
      session: sessionId,
      elapsed_ms: elapsed,
      steps: roundSteps(steps),
    })
    reportHookFailure("prompt", e)
    // oxlint-disable-next-line typescript/return-await -- drain failure must bypass this catch
    return drainOutput().then(() => process.exit(1))
  }
}

// ============================================================================
// Hook command — PreCompact
// ============================================================================

/**
 * Bounds for the two read-only git reads the pre-compact context carries. The whole hook has a small budget, so each
 * read gets a fraction of it; a read that overruns is named in the context rather than dropped silently.
 */
const PRECOMPACT_GIT_BOUNDS: BoundedProcessBounds = {
  timeoutMs: 1500,
  killGraceMs: 200,
  reapGraceMs: 200,
  drainGraceMs: 200,
  maxOutputBytes: 256 * 1024,
}

/** One bounded read-only git read in `subjectRoot`; a failure is named in the returned text, never swallowed. */
async function preCompactGit(subjectRoot: string, args: readonly string[]): Promise<string> {
  const label = `git ${args.join(" ")}`
  try {
    const result = await runBoundedProcessCommand(
      ["git", "--no-optional-locks", "-C", subjectRoot, ...args],
      PRECOMPACT_GIT_BOUNDS,
    )
    const text = `${result.stdout}${result.stderr}`.trimEnd()
    return text.length > 0 ? text : `(${label} produced no output)`
  } catch (err) {
    return `(${label} failed for ${subjectRoot}: ${err instanceof Error ? err.message : String(err)})`
  }
}

/** The in-progress beads from the bound vault, or the reason they could not be read — never a silent empty list. */
function preCompactInProgressBeads(): string[] {
  try {
    const db = getVaultDb()
    if (!db) return ["(beads unavailable — no --vault-db bound to this hook line)"]
    const rows = db
      .prepare(
        "SELECT fs_path, title FROM nodes WHERE task_status = 'wip' AND fs_path IS NOT NULL ORDER BY parent_idx, item LIMIT 40",
      )
      .all() as { fs_path: string; title: string | null }[]
    if (rows.length === 0) return ["(none)"]
    return rows.map((row) =>
      row.title === null || row.title.length === 0 ? row.fs_path : `${row.fs_path} — ${row.title}`,
    )
  } catch (err) {
    return [`(beads unavailable — ${err instanceof Error ? err.message : String(err)})`]
  }
}

/**
 * PreCompact hook (`tribe hook pre-compact`).
 *
 * Ported from `tools/agent-rig/hooks/pre-compact.sh` (deleted in the same landing, 22967; its content was the
 * specification): it prints a RESUME directive for this session's tracking bead, the in-progress beads, the recent
 * commits, and the uncommitted changes, so the compact summary carries the session's state.
 *
 * The event routes here by the CLI argument (`dispatchHook("pre-compact")`), never by sniffing `hook_event_name` from
 * stdin as the pre-2026-10-13 dispatch did — that sent a PreCompact payload to the UserPromptSubmit handler, which
 * needs `prompt`, so it emitted nothing (@cto, 22967).
 *
 * stdout is the context channel (the shell's contract, and this handler's whole product); diagnostics go through
 * loggily. Exit is always 0: a compaction must not be blocked over the hook's own input shape.
 */
/**
 * The tree the checkpoint reads as data: the seat's CODE checkout, never the STATE container.
 *
 * Ported from `tools/agent-rig/hooks/hook-roots.sh`'s `HOOK_SUBJECT_ROOT`, which the retired shell sourced:
 * `CLAUDE_PROJECT_DIR`, and when that root is the STATE container (a seat rooted at `/hh`), its `dev/` CODE
 * child. Without the child rule a PreCompact payload with `cwd: /hh` runs `git` inside STATE: the wrong
 * checkpoint context, and a tree our git rules forbid reading (@dev/review2 22967; @cto 6ee4df24,
 * @hh/tooling/26948). `CLAUDE_PROJECT_DIR` is the live registered-hook path, where parity is exact.
 *
 * When it is unset the shell fell back to its own hook-file CODE root (`HOOK_CODE_ROOT`), which this
 * daemon-side handler has no path to; it falls back to the payload's cwd, then this process's cwd. That
 * fallback is a hand-run path only, never the registered hook.
 */
function preCompactSubjectRoot(payloadCwd?: string): string {
  const configured = process.env.CLAUDE_PROJECT_DIR
  const base = configured !== undefined && configured.length > 0 ? configured : (payloadCwd ?? process.cwd())
  return fs.existsSync(path.join(base, "dev", "tools", "agent-rig", "hooks")) ? path.join(base, "dev") : base
}

export async function cmdPreCompact(): Promise<void> {
  const startTime = Date.now()
  let sessionId: string | undefined
  let shortId = ""
  let subjectRoot = preCompactSubjectRoot()
  const out: string[] = []
  try {
    const stdin = await readStdin()
    let input: { session_id?: string; cwd?: string } = {}
    if (stdin.trim().length > 0) {
      try {
        input = JSON.parse(stdin) as { session_id?: string; cwd?: string }
      } catch (err) {
        preCompactLog.warn?.("pre-compact stdin was not JSON", {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    sessionId = input.session_id
    shortId = sessionId === undefined ? "" : sessionId.slice(0, 8)
    subjectRoot = preCompactSubjectRoot(input.cwd)

    let trackingBead: string | null = null
    if (shortId.length > 0) {
      try {
        // Reads the bound path at this boundary: one of the two non-recall readers left on the binding (@cto 456e6e77).
        const match = searchVault(shortId, 5, getVaultDbPath()).find(
          (m) => m.fsPath !== null && m.fsPath.endsWith(".md"),
        )
        trackingBead = match?.fsPath ?? null
      } catch (err) {
        preCompactLog.warn?.("pre-compact vault search failed", {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    if (trackingBead !== null) {
      out.push(`# RESUME: km bd show ${trackingBead}`)
      out.push(
        `This session was working on ${trackingBead}. After compact, run 'km bd show ${trackingBead}' FIRST to recover context.`,
      )
      out.push("Do NOT list all beads or start new work — resume this bead.")
      out.push("")
    }

    out.push(`# Session State at Compact Time (session: ${shortId.length > 0 ? shortId : "unknown"})`)
    out.push("")
    out.push("## In-Progress Beads")
    out.push(...preCompactInProgressBeads())
    out.push("")
    out.push("## Recent Commits")
    out.push(await preCompactGit(subjectRoot, ["log", "--oneline", "-10"]))
    out.push("")
    out.push("## Uncommitted Changes")
    out.push(await preCompactGit(subjectRoot, ["status", "--short"]))
    out.push("")

    if (trackingBead === null) {
      out.push("")
      out.push(
        shortId.length === 0
          ? "WARNING: no session id on the PreCompact payload, so no tracking bead could be looked up. Context may be lost after compact."
          : `WARNING: No tracking bead found for session ${shortId}. Context may be lost after compact.`,
      )
    }

    console.log(out.join("\n"))
    preCompactLog.info?.("pre-compact context emitted", {
      session: sessionId,
      lines: out.length,
      elapsed_ms: Date.now() - startTime,
    })
  } catch (err) {
    // The context is this hook's whole product, so a failure is visible on the same stdout channel as a
    // plainly-labelled warning rather than an empty exit 0 (@cto, 22967).
    preCompactLog.error?.(err instanceof Error ? err : new Error(String(err)), "pre-compact FATAL", {
      session: sessionId,
    })
    console.log(
      `# Session State at Compact Time (session: ${shortId.length > 0 ? shortId : "unknown"})\n` +
        `(pre-compact context unavailable: ${err instanceof Error ? err.message : String(err)})`,
    )
  }
  // oxlint-disable-next-line typescript/return-await -- a failing drain must stay visible
  return drainOutput().then(() => process.exit(0))
}

// ============================================================================
// Remember command — manual daily summarization (NOT hook-dispatched)
// ============================================================================

/**
 * Daily summarization for any unprocessed past days (delegates to
 * `summarizeUnprocessedDays`). Despite the hook-shaped name and the
 * stdin-JSON protocol below, this is NOT dispatched by any Claude Code hook
 * today: `packages/daemon/src/lib/hook-dispatch.ts`'s `dispatchHook()`
 * routes `session-end` to `cmdSessionEnd` only (cheap, detached index
 * refresh) — it never references this function, and its `HookEngine` type
 * doesn't even name it.
 *
 * That's deliberate, not an oversight. `summarizeUnprocessedDays` can
 * perform a real synchronous LLM call, a `git log` spawn, and retro-bead
 * creation whenever a day is unprocessed, with no per-day lock — firing it
 * unconditionally on every SessionEnd would risk blocking the hook and
 * racing duplicate summarize/retro-bead work when multiple sessions end near
 * the same day boundary. Manual-only is the fix: reach this via `recall
 * remember` (hidden CLI subcommand — mirrors the SessionEnd stdin-JSON shape
 * for scripted/manual invocation) or the public `recall summarize` verb;
 * both call the same underlying engine. Full rationale + event flow:
 * /hh/docs/reference/tribe/recall.md § "Automatic injection — hook-driven,
 * not tool-driven".
 * Dispatch-table pin: `packages/daemon/src/lib/hook-dispatch.test.ts`.
 */
export async function cmdRemember(opts: { json?: boolean }): Promise<void> {
  const startTime = Date.now()
  try {
    // Read stdin (required by hook protocol, but we only need session_id for logging)
    const stdin = await readStdin()
    let sessionId = "unknown"
    try {
      const input = JSON.parse(stdin) as { session_id?: string }
      sessionId = input.session_id?.slice(0, 8) ?? "unknown"
    } catch {
      // Best-effort parse
    }

    // Summarize any unprocessed past days (not today — still in progress)
    const results = await summarizeUnprocessedDays({ limit: 3, verbose: false })
    const elapsed = Date.now() - startTime

    const summarized = results.filter((r) => !r.skipped)
    const skipped = results.filter((r) => r.skipped)
    if (results.length === 0) {
      // An empty result set is the ONE signal that no day was eligible.
      rememberLog.info?.("no unprocessed days", { elapsed_ms: elapsed, session: sessionId })
    } else {
      if (summarized.length > 0) {
        rememberLog.info?.("summarized", {
          days_count: summarized.length,
          days: summarized.map((r) => r.date),
          elapsed_ms: elapsed,
          session: sessionId,
        })
      }
      if (skipped.length > 0) {
        // Name the eligible days and their existing reasons: a skip is work the
        // day selector chose, never "no unprocessed days" (27702 §5).
        const detail = skipped.map((r) => `${r.date} (${r.reason ?? "skipped"})`).join(", ")
        rememberLog.info?.(`skipped ${skipped.length} eligible day(s): ${detail}`, {
          elapsed_ms: elapsed,
          session: sessionId,
        })
      }
    }

    if (opts.json) {
      // --json CLI mode: print structured output on stdout for the user.
      // Not invoked from the hook protocol path; safe to use console.log.
      console.log(JSON.stringify(results, null, 2))
    }
  } catch (e) {
    const elapsed = Date.now() - startTime
    rememberLog.error?.(e instanceof Error ? e : new Error(String(e)), "FATAL: unhandled error", {
      elapsed_ms: elapsed,
    })
    process.exit(1)
  }
}
