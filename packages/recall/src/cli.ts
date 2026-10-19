#!/usr/bin/env bun
/**
 * recall.ts - Unified CLI for Claude Code session history
 *
 * Searches indexed sessions using FTS5 with optional LLM synthesis.
 * Replaces both the old `recall.ts` and `history.ts` CLIs.
 *
 * Usage:
 *   recall <query>                    # Search + LLM synthesis (default)
 *   recall <query> --raw              # Raw search results
 *   recall index [--incremental]      # Build/rebuild FTS5 index
 *   recall status                     # Dashboard: activity + stats + index health
 *   recall sessions [id]              # List sessions or show details
 *   recall files [pattern]            # List/search file writes
 *   recall files --restore <file>     # Recover file content
 *   recall export [session|--all]      # Export transcript markdown for qmd
 *   recall --vault-db <path> <verb…>  # Bind the km vault for any verb (leading, global)
 *
 * Internal/manual (hook-shaped, but NOT hook-dispatched):
 *   recall remember                   # daily summarization, stdin-JSON shaped
 *                                      # like SessionEnd, but dispatchHook()
 *                                      # never calls it — manual-only by
 *                                      # design (see hooks.ts docstring on
 *                                      # cmdRemember +
 *                                      # /hh/docs/reference/tribe/recall.md).
 *
 * Note: SessionStart, UserPromptSubmit, and SessionEnd hooks are dispatched
 * via `tribe hook <event>` — not recall CLI — as of @bearly/tribe 0.10.0.
 */

import { Command, CommanderError, int, uint } from "@silvery/commander"
import { DEFAULT_PLAN_TIMEOUT_MS, DEFAULT_SYNTHESIS_TIMEOUT_MS } from "./history/recall-shared"
import { cmdSearch, type SearchOptions } from "./lib/search"
import { resolveVaultDbFlag } from "./lib/vault-db"
import { bindVaultDb } from "./history/vault-fts"
import { bindSnapshot, getSnapshotPath } from "./history/db.ts"
import { cmdStatus } from "./lib/status"
import { cmdSessions, cmdIndex, RECALL_INDEX_BUSY_EXIT, RECALL_INDEX_PRUNE_REFUSED_EXIT } from "./lib/sessions"
import { cmdFiles } from "./lib/files"
import { cmdRemember } from "./lib/hooks"
import { cmdSummarize, cmdWeekly, cmdShow } from "./lib/summarize-daily"
import { cmdExport } from "./qmd-export"

// ============================================================================
// CLI
// ============================================================================

const SUBCOMMANDS = new Set([
  "search",
  "index",
  "migrate",
  "status",
  "sessions",
  "files",
  "export",
  "remember",
  "summarize",
  "weekly",
  "show",
  "current-brief",
  "help",
  "--help",
  "-h",
  "--version",
  "-V",
])

const program = new Command()

program
  .name("recall")
  .description("Search and manage Claude Code session history")
  .version("1.0.0")
  .usage("[--vault-db <path> | --snapshot <path>] [command|query] [options]")
  .exitOverride()
  .configureOutput({
    writeErr: (str) => console.error(str.trimEnd()),
  })
  .addHelpText(
    "after",
    `\nThe km vault is bound only on the call line, before any command:\n` +
      `  --vault-db <path>  the vault database every command reads; no environment\n` +
      `                     variable binds it, and recall never discovers one from the cwd\n` +
      `  --snapshot <path>  immutable Recall index; raw indexed search only, no live sources\n` +
      `                     select before the command; cannot combine with --vault-db\n` +
      `\nExit codes:\n` +
      `  0  clean success — the index provenance is complete; an empty result\n` +
      `     is authoritative; snapshot success is scoped only to the selected file\n` +
      `  1  hard failure — an unexpected crash, not the degraded path below\n` +
      `  2  CLI usage error (bad flags, removed subcommand)\n` +
      `  3  degraded — index provenance is stale, missing, or unknown, or LLM\n` +
      `     synthesis failed. Positive hits still print; degraded empty JSON is\n` +
      `     discriminated with results:null and total:null, never []/0.\n` +
      `  ${RECALL_INDEX_BUSY_EXIT}  busy — index writer lock is held by another process\n` +
      `  ${RECALL_INDEX_PRUNE_REFUSED_EXIT}  refused — an incremental share-cap prune was refused\n` +
      `     because it would remove too many sessions; the index itself committed\n`,
  )

// ── Default: search ─────────────────────────────────────────────────────
program
  .command("search", { hidden: true })
  .description("Search and synthesize session history")
  .argument("[query]", "Search query")
  .option("--raw", "Skip LLM synthesis, show raw FTS5 snippets")
  .option("--json", "JSON output")
  .option("-s, --since <time>", "Lower bound: Nh, Nd, Nw, today, yesterday, all or explicit-zone ISO (default: 30d)")
  .option(
    "--until <instant>",
    "Inclusive indexed upper bound: explicit-zone ISO (at most milliseconds), or relative time",
  )
  .option("-n, --limit <num>", "Max results (default: 10)", int)
  .option("--timeout <ms>", `LLM timeout in ms (default: ${DEFAULT_SYNTHESIS_TIMEOUT_MS})`, uint)
  .option("-p, --project <glob>", "Project filter")
  .option("-g, --grep", "Regex mode (slower, scans files)")
  .option("-q, --question", "User messages only (implies --raw)")
  .option("-r, --response", "Assistant messages only (implies --raw)")
  .option("-t, --tool <name>", "Tool filter: Write, Bash, etc. (implies --raw)")
  .option("--session <id>", "Specific session (implies --raw)")
  .option("-i, --include <types>", "Content types: m,b,e,d,c or long names (implies --raw)")
  .option("--agent", "LLM query-planner mode: plan → fan out → rerank → synthesize")
  .option("--round2 <mode>", "Round 2 mode: auto|wider|deeper|off (default auto)")
  .option("--max-rounds <n>", "Cap agent rounds (1 or 2, default 2)", int)
  .option("--debug-plan", "Print full planner output each round (implies --agent)")
  .option("--plan-timeout <ms>", `One planner attempt's deadline in ms (default: ${DEFAULT_PLAN_TIMEOUT_MS})`, uint)
  .option("--no-speculative-synth", "Disable speculative synthesis on round-1 (runs synth only after round 2 merge)")
  .option(
    "--no-refresh",
    "Compatibility flag: skip freshness classification; index provenance is unknown and search exits 3",
  )
  .actionMerged(async (opts) => {
    const searchOpts = opts as unknown as SearchOptions & { query?: string }
    await cmdSearch(searchOpts.query, searchOpts)
  })

// ── index ───────────────────────────────────────────────────────────────
program
  .command("index")
  .description("Build/rebuild FTS5 index")
  .option("--incremental", "Only index new sessions")
  .option("--full", "Full re-index of all sessions including codex transcripts")
  .option("--rebuild", "Full re-index of all sessions including codex transcripts (alias for --full)")
  .option("--allow-large-prune", "Allow pruning more than 20% of sessions during incremental pruning")
  .option("--force", "Force commit even if session rows shrunk")
  .option("--path <file>", "Index specific transcript file")
  .option("--project-root <path>", "Project root for indexing project sources (beads, docs, memory)")
  .option("--migrate", "Run pending database schema migrations")
  .action(
    async (opts: {
      incremental?: boolean
      full?: boolean
      rebuild?: boolean
      allowLargePrune?: boolean
      force?: boolean
      path?: string
      projectRoot?: string
      migrate?: boolean
    }) => {
      await cmdIndex({
        ...opts,
        full: opts.full || opts.rebuild,
      })
    },
  )

// ── migrate ─────────────────────────────────────────────────────────────
program
  .command("migrate")
  .description("Run pending database schema migrations (e.g. v2 -> v3)")
  .action(async () => {
    await cmdIndex({ migrate: true })
  })

// ── status ──────────────────────────────────────────────────────────────
program
  .command("status")
  .description("Dashboard: activity, stats, index health, hook config (bounded — no LLM calls by default)")
  .option("--json", "Output as JSON")
  .option(
    "--bench",
    'Also run the four FTS search benchmarks ("bug fix", "inline edit", "test" (1d), project knowledge) plus the LLM synthesis test and multi-model race (slow)',
  )
  .action(async (opts: { json?: boolean; bench?: boolean }) => {
    await cmdStatus(opts)
  })

// ── sessions ────────────────────────────────────────────────────────────
program
  .command("sessions")
  .argument("[id]", "Session ID to show details for")
  .description("List sessions or show session details")
  .option("-p, --project <glob>", "Project filter")
  .actionMerged(async (opts: { id?: string; project?: string }) => {
    await cmdSessions(opts.id, opts)
  })

// ── files ───────────────────────────────────────────────────────────────
program
  .command("files")
  .argument("[pattern]", "File pattern to search for")
  .description("List/search file writes or restore content")
  .option("--restore <file>", "Restore file content")
  .option("--date <date>", "Filter by date (e.g., 2026-02)")
  .actionMerged(async (opts: { pattern?: string; restore?: string; date?: string }) => {
    await cmdFiles(opts.pattern, opts)
  })

// ── qmd transcript export adapter ──────────────────────────────────────
program
  .command("export")
  .argument("[session]", "Session ID or transcript JSONL path")
  .description("Export Claude Code transcripts as quality-gated markdown for qmd")
  .option("--all", "Export every transcript")
  .option("--force", "Rewrite existing exports")
  .option("--catchup", "Export only missing transcripts")
  .option("--hook", "Read SessionEnd input and emit a valid hook response")
  .actionMerged((opts: { session?: string; all?: boolean; force?: boolean; catchup?: boolean; hook?: boolean }) => {
    cmdExport(opts)
  })

// ── remember (internal) ─────────────────────────────────────────────────
program
  .command("remember", { hidden: true })
  .description(
    "Manual daily summarization, SessionEnd-stdin-JSON-shaped but NOT hook-dispatched (see /hh/docs/reference/tribe/recall.md)",
  )
  .option("--json", "Output as JSON")
  .action(async (opts: { json?: boolean }) => {
    await cmdRemember(opts)
  })

// ── summarize ─────────────────────────────────────────────────────────
program
  .command("summarize")
  .argument("[date]", "Date to summarize (default: all unprocessed days)")
  .description("Daily summary across all sessions (default: all unprocessed days)")
  .option("-p, --project <glob>", "Project filter")
  .actionMerged(async (opts: { date?: string; project?: string }) => {
    await cmdSummarize(opts.date, { verbose: true, project: opts.project })
  })

// ── show ────────────────────────────────────────────────────────────
program
  .command("show")
  .argument("[date]", "Date or 'week' (default: list recent)")
  .description("Show existing summaries (default: list recent; YYYY-MM-DD: that day; 'week': latest weekly)")
  .actionMerged(async (opts: { date?: string }) => {
    await cmdShow(opts.date)
  })

// ── weekly ──────────────────────────────────────────────────────────
program
  .command("weekly")
  .argument("[date]", "Any day in the target week (default: last week)")
  .description("Weekly summary from daily summaries (date = any day in the target week, default: last week)")
  .actionMerged(async (opts: { date?: string }) => {
    await cmdWeekly(opts.date)
  })

// ── current-brief ────────────────────────────────────────────────────
program
  .command("current-brief")
  .description("Print a compact summary of the current agent session (for /recall skill embed)")
  .option("--json", "JSON output")
  .action(async (opts: { json?: boolean }) => {
    const { getCurrentSessionContextWithDiagnostics, renderSessionBriefResult } =
      await import("./lib/session-context.ts")
    const result = getCurrentSessionContextWithDiagnostics()
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2))
    } else {
      console.log(renderSessionBriefResult(result))
    }
  })

// ============================================================================
// Entry point
// ============================================================================

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  // Resolve leading file selections before default-search routing or any command action.
  try {
    const leading = takeLeadingBindings(argv)
    if (leading.snapshot !== undefined && leading.vaultDb !== undefined) {
      throw new Error("--snapshot cannot combine with --vault-db: snapshot results use only the selected index")
    }
    if (leading.snapshot !== undefined) {
      if (typeof leading.snapshot !== "string" || leading.snapshot.trim() === "") {
        throw new Error("--snapshot requires a nonempty index file path")
      }
      bindSnapshot(leading.snapshot)
    }
    const bound = resolveVaultDbFlag(leading.vaultDb)
    if (bound !== null) bindVaultDb(bound)
    argv = leading.rest
  } catch (error) {
    // A refused --vault-db is a usage error, exit 2 as the table above documents. The one rule returns the
    // refusal and each surface maps it to its own documented exit; the hook line keeps 1.
    console.error(`[recall] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  }

  // No args → show help (Step 0: fix exitOverride crash)
  if (argv.length === 0) {
    try {
      program.help()
    } catch (e) {
      if (e instanceof CommanderError && e.exitCode === 0) {
        process.exit(0)
      }
      throw e
    }
    return
  }

  // Hook subcommands were removed in @bearly/tribe 0.10.0 — fail loud instead
  // of falling through to a search for the literal event name.
  if (argv[0] === "session-start" || argv[0] === "session-end") {
    console.error(`[recall] '${argv[0]}' was removed in @bearly/tribe 0.10.0 — use 'tribe hook ${argv[0]}' instead`)
    process.exit(2)
  }
  if (argv[0] === "hook") {
    console.error(`[recall] 'hook' was removed in @bearly/tribe 0.10.0 — use 'tribe hook <event>' instead`)
    process.exit(2)
  }

  // If first arg isn't a known subcommand, treat as `search <query> [opts]`
  const firstArg = argv[0]
  if (firstArg === undefined || !SUBCOMMANDS.has(firstArg)) {
    argv = ["search", ...argv]
  }

  const command = argv[0]
  if (
    getSnapshotPath() !== null &&
    command !== undefined &&
    !["search", "help", "--help", "-h", "--version", "-V"].includes(command)
  ) {
    console.error(
      `[recall] snapshot ${getSnapshotPath()} supports raw indexed search only; command ${argv[0]} is unavailable`,
    )
    process.exit(2)
  }

  try {
    await program.parseAsync(["node", "recall", ...argv])
  } catch (e) {
    if (e instanceof CommanderError) {
      if (e.exitCode === 0) {
        process.exit(0)
      }
      // Commander already printed the error. Any non-zero commander exit is a bad flag or argument, which the
      // exit-code table above documents as 2 (review-adhoc5 P3 on 25149 d, placed by @chief 6b9943f6).
      process.exit(2)
    }
    throw e
  }
}

/** One leading-binding parser; valueless flags carry true for the named usage error. */
function takeLeadingBindings(argv: string[]): {
  vaultDb?: string | boolean
  snapshot?: string | boolean
  rest: string[]
} {
  const flags = ["--vault-db", "--snapshot"] as const
  const dashDashIndex = argv.indexOf("--")
  const optionTokens = dashDashIndex === -1 ? argv : argv.slice(0, dashDashIndex)
  for (const flag of flags) {
    if (optionTokens.filter((arg) => arg === flag || arg.startsWith(`${flag}=`)).length > 1) {
      throw new Error(`error: option '${flag}' cannot be repeated`)
    }
  }
  const result: { vaultDb?: string | boolean; snapshot?: string | boolean; rest: string[] } = { rest: argv }
  while (result.rest.length > 0) {
    const first = result.rest[0]
    if (first === undefined) break
    const flag = flags.find((name) => first === name || first.startsWith(`${name}=`))
    if (flag === undefined) break
    let raw: string | boolean
    if (first.startsWith(`${flag}=`)) {
      raw = first.slice(flag.length + 1)
      result.rest = result.rest.slice(1)
    } else {
      const value = result.rest[1]
      const hasValue = value !== undefined && !value.startsWith("-")
      raw = hasValue ? value : true
      result.rest = result.rest.slice(hasValue ? 2 : 1)
    }
    if (flag === "--vault-db") result.vaultDb = raw
    else result.snapshot = raw
  }
  return result
}

if (import.meta.main) {
  try {
    await main()
  } catch (e) {
    console.error(`[recall] FATAL: ${e instanceof Error ? `${e.message}\n${e.stack}` : String(e)}`)
    process.exit(1)
  }
}
