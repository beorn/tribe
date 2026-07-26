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
import { isTribeNameShape } from "tribe-wire/lib/persona-name"
import { evaluateAdapterReexec } from "./supervisor-policy.ts"

const PLUGIN_CHILD = "TRIBE_PLUGIN_ADAPTER_CHILD"
const PLUGIN_PROVIDER_PARENT_PID = "TRIBE_PLUGIN_PROVIDER_PARENT_PID"
const PLUGIN_RESUME_JOINED = "TRIBE_PLUGIN_RESUME_JOINED"
const REEXEC_EXIT_CODE = 75
const REEXEC_JOINED_OFFSET = 1
const GENERATION_REEXEC_OFFSET = 2
const LAST_REEXEC_EXIT_CODE = REEXEC_EXIT_CODE + GENERATION_REEXEC_OFFSET + REEXEC_JOINED_OFFSET
const REMEDY =
  "tribe plugin reconnect failed after current-disk re-exec; restart the host session or reinstall the Tribe plugin."
const PROVIDER_PARENT_REMEDY =
  "tribe plugin wrapper requires valid provider-parent provenance from a complete live managed launch; restart the host session or reinstall the Tribe plugin."
const LEGACY_PARENT_WARNING =
  "tribe plugin wrapper: managed launch supplied no provider-parent PID; falling back to the wrapper's real provider parent. Relaunch the host session to restore full launch provenance."

function supervisedIdentityName(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null || !("tribePluginIdentity" in message)) return undefined
  const name = (message as { tribePluginIdentity?: unknown }).tribePluginIdentity
  return typeof name === "string" && isTribeNameShape(name) ? name : undefined
}

function waitForExit(child: ChildProcess): Promise<{ code: number | null; error?: Error }> {
  return new Promise((resolve) => {
    child.once("error", (error) => resolve({ code: null, error }))
    child.once("exit", (code) => resolve({ code }))
  })
}

function waitForRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs)
  })
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

function resolveProviderParentPid(): number {
  const raw = process.env[PLUGIN_PROVIDER_PARENT_PID]?.trim() ?? ""
  const launchId = process.env.TRIBE_LAUNCH_ID?.trim() ?? ""
  // An ABSENT parent PID is indistinguishable from a standalone install or a
  // host launched before the bootstrap started injecting it, so it falls back to
  // the wrapper's real provider parent — loudly, never silently. Rejecting it
  // strands every already-running seat: a host's env is fixed at launch, so the
  // only remedy is relaunching every seat, and the refusal surfaces to the
  // provider as a bare transport error with the remedy text nowhere in view.
  // A SUPPLIED-but-invalid PID is a genuine incomplete tuple and still throws.
  if (raw.length === 0) {
    if (launchId.length > 0) process.stderr.write(`${LEGACY_PARENT_WARNING}\n`)
    return process.ppid
  }
  const pid = Number(raw)
  if (
    launchId.length === 0 ||
    !/^[1-9]\d*$/u.test(raw) ||
    !Number.isSafeInteger(pid) ||
    pid === process.pid ||
    !processExists(pid)
  ) {
    throw new Error(PROVIDER_PARENT_REMEDY)
  }
  return pid
}

async function superviseAdapter(): Promise<void> {
  // The wrapper is an implementation detail between the provider host and
  // the adapter. A managed Hab launch supplies the authoritative harness PID;
  // a standalone plugin uses the wrapper's actual provider parent. Capture the
  // resolved boundary once so every child/re-exec reports one logical owner.
  let providerParentPid: number
  try {
    providerParentPid = resolveProviderParentPid()
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : PROVIDER_PARENT_REMEDY}\n`)
    process.exitCode = 2
    return
  }
  let active: ChildProcess | null = null
  let stopping = false
  let consecutiveReexecs = 0
  let resumeJoined = false
  const launchName = process.env.TRIBE_NAME?.trim()
  let resumeName = launchName && isTribeNameShape(launchName) ? launchName : undefined
  const forward = (signal: NodeJS.Signals) => {
    stopping = true
    active?.kill(signal)
  }
  process.once("SIGINT", () => forward("SIGINT"))
  process.once("SIGTERM", () => forward("SIGTERM"))

  while (!stopping) {
    const startedAt = Date.now()
    const canResumeJoined = resumeJoined && resumeName !== undefined
    active = spawn(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
      stdio: ["inherit", "inherit", "inherit", "ipc"],
      env: {
        ...process.env,
        [PLUGIN_CHILD]: "1",
        [PLUGIN_PROVIDER_PARENT_PID]: String(providerParentPid),
        TRIBE_PLUGIN_REEXEC_EXIT_CODE: String(REEXEC_EXIT_CODE),
        ...(canResumeJoined ? { [PLUGIN_RESUME_JOINED]: "1", TRIBE_NAME: resumeName } : {}),
      },
    })
    active.on("message", (message) => {
      const name = supervisedIdentityName(message)
      if (name !== undefined) resumeName = name
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
