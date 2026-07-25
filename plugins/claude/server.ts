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

import { spawn, type ChildProcess } from "node:child_process"
import { fileURLToPath } from "node:url"
import { evaluateAdapterReexec } from "./supervisor-policy.ts"

process.env.TRIBE_DAEMON_SCRIPT ??= fileURLToPath(import.meta.resolve("tribe-daemon"))

const PLUGIN_CHILD = "TRIBE_PLUGIN_ADAPTER_CHILD"
const PLUGIN_PROVIDER_PARENT_PID = "TRIBE_PLUGIN_PROVIDER_PARENT_PID"
const PLUGIN_RESUME_JOINED = "TRIBE_PLUGIN_RESUME_JOINED"
const REEXEC_EXIT_CODE = 75
const REEXEC_JOINED_OFFSET = 1
const GENERATION_REEXEC_OFFSET = 2
const LAST_REEXEC_EXIT_CODE = REEXEC_EXIT_CODE + GENERATION_REEXEC_OFFSET + REEXEC_JOINED_OFFSET
const REMEDY =
  "tribe plugin reconnect failed after current-disk re-exec; restart the host session or reinstall the Tribe plugin."

function waitForExit(child: ChildProcess): Promise<{ code: number | null; error?: Error }> {
  return new Promise((resolve) => {
    child.once("error", (error) => resolve({ code: null, error }))
    child.once("exit", (code) => resolve({ code }))
  })
}

function waitForRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs))
}

async function superviseAdapter(): Promise<void> {
  // The wrapper is an implementation detail between the provider host and
  // the adapter. Capture the provider boundary once so every supervised
  // child/re-exec from this wrapper reports the same logical launch owner.
  const providerParentPid = process.ppid
  let active: ChildProcess | null = null
  let stopping = false
  let consecutiveReexecs = 0
  let resumeJoined = false
  const forward = (signal: NodeJS.Signals) => {
    stopping = true
    active?.kill(signal)
  }
  process.once("SIGINT", () => forward("SIGINT"))
  process.once("SIGTERM", () => forward("SIGTERM"))

  while (!stopping) {
    const startedAt = Date.now()
    active = spawn(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
      stdio: "inherit",
      env: {
        ...process.env,
        [PLUGIN_CHILD]: "1",
        [PLUGIN_PROVIDER_PARENT_PID]: String(providerParentPid),
        TRIBE_PLUGIN_REEXEC_EXIT_CODE: String(REEXEC_EXIT_CODE),
        ...(resumeJoined ? { [PLUGIN_RESUME_JOINED]: "1" } : {}),
      },
    })
    const result = await waitForExit(active)
    active = null
    if (stopping) return
    if (result.error) {
      process.stderr.write(`${REMEDY} (${result.error.message})\n`)
      process.exitCode = 2
      return
    }
    if (result.code === null || result.code < REEXEC_EXIT_CODE || result.code > LAST_REEXEC_EXIT_CODE) {
      process.exitCode = result.code ?? 1
      return
    }

    const reexecOffset = result.code - REEXEC_EXIT_CODE
    resumeJoined = reexecOffset % GENERATION_REEXEC_OFFSET === REEXEC_JOINED_OFFSET
    const generationChange = reexecOffset >= GENERATION_REEXEC_OFFSET
    const maxConsecutiveReexecs = generationChange ? undefined : 1
    const decision = evaluateAdapterReexec(consecutiveReexecs, Date.now() - startedAt, maxConsecutiveReexecs)
    consecutiveReexecs = decision.consecutiveReexecs
    if (!decision.retry) {
      process.stderr.write(`${REMEDY}\n`)
      process.exitCode = 2
      return
    }
    await waitForRetry(decision.retryDelayMs)
  }
}

if (process.env[PLUGIN_CHILD] === "1") await import("tribe-wire/stdio")
else await superviseAdapter()
