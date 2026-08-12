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

const ARGV_FORWARDED_SUBCOMMANDS = new Set(["mcp"])
const VERSION_FLAGS = new Set(["--version", "-V", "-v", "version"])

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const sub = argv[0]

  // Private process boundary used by connectOrStart and ownerless standalone
  // reload adoption. It is intentionally absent from Commander/help: callers
  // use the typed client helper, not this argv protocol.
  if (sub === "__standalone-supervisor") {
    const { runStandaloneSupervisor } = await import("./standalone-supervisor.ts")
    process.exitCode = await runStandaloneSupervisor(argv.slice(1))
    return
  }

  // Version identity runs BEFORE Commander, short-circuited like `mcp`, so the
  // output is the canonical `<name> <version>+<sha>` shape (the drill-parseable
  // form the rest of the system uses) rather than Commander's bare semver.
  // @km/infra/20359 — vendor-local id (tribe-wire's own version + git sha).
  if (sub && VERSION_FLAGS.has(sub)) {
    const { tribeWireRuntimeId } = await import("./runtime-id.ts")
    process.stdout.write(`tribe-wire ${tribeWireRuntimeId()}\n`)
    return
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
        return
    }
  }

  // Commander-routed subcommands (Phase A.2 verb families).
  const { Command } = await import("@silvery/commander")
  const program = new Command("tribe-wire")
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
  registerReadCommands(program)
  registerSendCommands(program)

  // Defer to Commander — it handles --help, unknown-subcommand errors, and exits.
  await program.parseAsync(process.argv)
}

await main()

export {}
