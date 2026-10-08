#!/usr/bin/env bun
/**
 * `tribe-wire` — unified CLI binary for the tribe-wire package.
 *
 * Phase A.MVP (@km/bearly/tribe-cli-unify-phase-a-substrate): shipped
 *   `tribe-wire mcp` (stdio adapter forwarder).
 *
 * Phase A.2 (@km/bearly/19231-tribe-cli-unify-phase-a2-verbs) round 1:
 *   ships read/inspect + send/messaging verb families. Each family
 *   registers via its own dispatcher (cli/read.ts, cli/send.ts) over
 *   `@silvery/commander`. Lifecycle / install / hooks families land in
 *   future rounds.
 *
 * Subcommands today:
 *
 *   tribe-wire mcp [--name <name>] [--role <role>] [--socket <path>] ...
 *     Runs the stdio MCP adapter that bridges Claude Code stdio to the
 *     tribe daemon's Unix socket. argv-forwarded (NOT Commander-parsed),
 *     so the stdio-adapter's own parseTribeArgs sees the full flag set.
 *
 *   tribe-wire status | sessions | members | pending | log | health | inbox-status | inbox-wait | reload | activity
 *     Read/inspect verbs — register via cli/read.ts (Family 1). `members` is
 *     the machine-readable row surface (JSON incl. launch_id + alive).
 *
 *   tribe-wire send | retro | alarm | alarm-status | alarm-ack
 *     Send/messaging verbs — register via cli/send.ts (Family 2).
 *
 *   tribe-wire restart | stop
 *     RPC-backed daemon lifecycle: restart re-execs via the lifecycle owner
 *     (SIGHUP path); stop shuts down cleanly (exit 0, no successor) and is
 *     guarded — `--force`, or the hab supervisor context. Spawn/ownership
 *     lifecycle otherwise lives outside tribe-wire (host plugin or the
 *     tribe-daemon package).
 */

import { isEntryModule } from "./lib/entry-module.ts"
import type { DoctorSection } from "./cli/read.ts"

export type { DoctorDiagnosticCheck, DoctorSection } from "./cli/read.ts"
export type WireCliOptions = Readonly<{
  doctorSections?: () => Promise<readonly DoctorSection[]>
}>

const ARGV_FORWARDED_SUBCOMMANDS = new Set(["mcp"])
const VERSION_FLAGS = new Set(["--version", "-V", "-v", "version"])

/**
 * Run the tribe-wire CLI over `argv` (process.argv's shape: runtime, script, then arguments) and resolve to its exit
 * code. It never exits the process itself; the entry below, or a host such as hh's `tribe` bin, sets process.exitCode
 * from it. `mcp` still reads process.argv, because the stdio adapter parses its own flags and re-execs from it.
 */
export async function main(argv: readonly string[], options: WireCliOptions = {}): Promise<number> {
  const args = argv.slice(2)
  const sub = args[0]

  // Private process boundary used by connectOrStart and ownerless standalone
  // reload adoption. It is intentionally absent from Commander/help: callers
  // use the typed client helper, not this argv protocol.
  if (sub === "__standalone-supervisor") {
    const { runStandaloneSupervisor } = await import("./standalone-supervisor.ts")
    return runStandaloneSupervisor(args.slice(1))
  }

  // Version identity runs BEFORE Commander, short-circuited like `mcp`, so the
  // output is the canonical `<name> <version>+<sha>` shape (the drill-parseable
  // form the rest of the system uses) rather than Commander's bare semver.
  // @km/infra/20359 — vendor-local id (tribe-wire's own version + git sha).
  if (sub && VERSION_FLAGS.has(sub)) {
    const { tribeWireRuntimeId } = await import("./runtime-id.ts")
    process.stdout.write(`tribe-wire ${tribeWireRuntimeId()}\n`)
    return 0
  }

  // argv-forwarded subcommands run BEFORE Commander parses, so the child can
  // see its own raw flags via process.argv. (Commander's strict mode would
  // reject unknown flags like --account that stdio-adapter parses itself.)
  if (sub && ARGV_FORWARDED_SUBCOMMANDS.has(sub)) {
    switch (sub) {
      case "mcp":
        // stdio-adapter parses its own argv via parseTribeArgs (strict: false).
        // The subcommand token 'mcp' sits at argv[2] and is silently ignored
        // as an extra positional; named flags (--name etc.) are picked up
        // normally. Hot-reload self-restart at stdio-adapter.ts:599 uses
        // `process.argv.slice(1)` which preserves the cli.ts entry — re-exec
        // re-enters this dispatcher cleanly.
        await import("./stdio-adapter.ts")
        return exitCodeSoFar()
    }
  }

  // Commander-routed subcommands (Phase A.2 verb families). `tribe health --json` owes its reader exactly
  // one hab-service-health/2 document on EVERY exit path, so its one caller wraps the whole family: a throw
  // out of registration or parse used to leave stdout empty, and a reader of an empty stdout can only say
  // the probe established nothing (bead 27871).
  try {
    return await runCommanderSubcommands(argv, options)
  } catch (error) {
    if (sub !== "health" || !args.includes("--json")) throw error
    await writeHealthProbeFailure(error)
    return exitCodeSoFar()
  }
}

/** The Commander-routed verb families, run under `main`'s health-probe guarantee. */
async function runCommanderSubcommands(argv: readonly string[], options: WireCliOptions): Promise<number> {
  const { Command, CommanderError } = await import("@silvery/commander")
  const program = new Command("tribe-wire")
  // Help, a usage error or an unknown command throws its exit code back here instead of exiting the process;
  // subcommands registered below inherit this.
  program.exitOverride()
  program.description("tribe-wire CLI — coordinate through the tribe daemon")
  program.addHelpText(
    "after",
    `\nMCP adapter (argv-forwarded, not Commander-parsed):\n` +
      `  tribe-wire mcp [--name X --role Y --socket /path ...]\n` +
      `    Bridges Claude Code stdio to the tribe daemon's Unix socket.\n` +
      `    See: bun packages/wire/src/stdio-adapter.ts --help\n`,
  )

  const { registerReadCommands } = await import("./cli/read.ts")
  const { registerSendCommands } = await import("./cli/send.ts")
  registerReadCommands(program, options.doctorSections)
  registerSendCommands(program)

  // Commander handles --help and unknown-subcommand errors, and answers them as an exit code.
  try {
    await program.parseAsync([...argv])
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode
    throw error
  }
  return exitCodeSoFar()
}

/** A subcommand that failed says so through process.exitCode; main hands that on as its answer. */
function exitCodeSoFar(): number {
  return typeof process.exitCode === "number" ? process.exitCode : 0
}

/**
 * The last-resort document for a health probe that failed before the verb could classify anything — its
 * module failed to load, or command registration threw. Deliberately import-free: `read.ts` owns the
 * classified form, and this one exists for the case where `read.ts` is exactly what did not arrive.
 * Nothing here may throw; the exit code is the /2 contract's `unknown` code (3).
 */
async function writeHealthProbeFailure(error: unknown): Promise<void> {
  let detail: string
  try {
    detail = error instanceof Error ? error.message : String(error)
  } catch {
    detail = "unprintable failure"
  }
  const document = {
    schema: "hab-service-health/2",
    service: "wire",
    state: "unknown",
    verdict: {
      kind: "unknown",
      reason: "unparsed",
      observed: `tribe health --json failed before it could measure anything: ${detail}`.slice(0, 2_000),
    },
  }
  try {
    process.stdout.write(`${JSON.stringify(document, null, 2)}\n`)
  } catch {
    // silent-fallback-allow: the probe's stdout pipe is already gone, so there is no surface left to report
    // to; the nonzero exit code below is the only signal this process can still send.
  }
  process.exitCode = 3
}

// Run only as the entry, never on import: importing ./cli must not act (hh #26691, @cto 2259658a).
if (isEntryModule(import.meta.url)) process.exitCode = await main(process.argv)
