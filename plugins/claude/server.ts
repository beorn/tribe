#!/usr/bin/env bun
/**
 * Tribe plugin server — thin wrapper.
 *
 * The MCP server runtime lives in `tribe-wire/stdio`. This file
 * is the plugin's invocation point: it imports and executes the stdio
 * adapter, which runs as a module-level bootstrap (no exported entry
 * function — the import has the side-effect).
 *
 * Why this exists: Claude Code's `.mcp.json` `command` runs a single
 * script. Pointing it at `node_modules/tribe-wire/.../stdio-adapter.mjs`
 * is brittle (resolution depends on dist layout); pointing it at this
 * file gives us a stable entry path that survives package layout changes.
 */

import { fileURLToPath } from "node:url"

process.env.TRIBE_DAEMON_SCRIPT ??= fileURLToPath(import.meta.resolve("tribe-daemon"))

await import("tribe-wire/stdio")
