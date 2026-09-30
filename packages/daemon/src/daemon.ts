#!/usr/bin/env bun
/**
 * Tribe Daemon — single process per project, sessions connect via Unix socket.
 *
 * Usage:
 *   bun tribe-daemon.ts                         # Auto-discover socket path
 *   bun tribe-daemon.ts --socket /path          # Explicit socket path
 *   bun tribe-daemon.ts --idle-quit-after never # Never idle-quit (also: 30m, 6h, 1800, 0)
 *   bun tribe-daemon.ts --fd 3                  # Inherit socket fd (for hot-reload re-exec)
 *   (--quit-timeout <seconds> still parses as a hidden deprecated alias)
 *
 * Setup automation (dispatch-and-exit, never boots the daemon pipe below):
 *   bun tribe-daemon.ts install [--dry-run] [--autostart daemon|library|never]
 *   bun tribe-daemon.ts uninstall [--dry-run]
 *   bun tribe-daemon.ts doctor              # is the Claude Code integration wired up?
 *
 * Importing this module does nothing; main(argv) runs the daemon, and the file runs it only as the entry
 * (hh #26691, @cto 2259658a). The boot itself is daemon-run.ts.
 */

import { isEntryModule } from "../../wire/src/lib/entry-module.ts"

/**
 * Run the tribe daemon (or its hook/install/uninstall/doctor verb) and resolve to its exit code once it stops. The boot
 * reads process.argv at module scope, so `argv` must be process.argv itself; any other array is refused by name rather
 * than silently ignored.
 */
export async function main(argv: readonly string[]): Promise<number> {
  if (argv !== process.argv) {
    throw new Error("TRIBE_DAEMON_ARGV: main(argv) runs the daemon over process.argv; pass process.argv itself")
  }
  await import("./daemon-run.ts")
  return typeof process.exitCode === "number" ? process.exitCode : 0
}

if (isEntryModule(import.meta.url)) process.exitCode = await main(process.argv)
