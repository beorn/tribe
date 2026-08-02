#!/usr/bin/env bun
/**
 * Tribe plugin server — stable adapter supervisor.
 *
 * The MCP server runtime lives in `tribe-wire/stdio`. This file is the plugin's
 * stable invocation point: it owns Claude Code's stdio channel and supervises
 * one adapter child, replacing that child without replacing the host channel.
 *
 * Why this exists: Claude Code's `.mcp.json` `command` runs a single
 * script. Pointing it at `node_modules/tribe-wire/.../stdio-adapter.mjs`
 * is brittle (resolution depends on dist layout); pointing it at this
 * file gives us a stable entry path that survives package layout changes.
 */

import { spawn, type ChildProcess } from "node:child_process"
import { fileURLToPath } from "node:url"
import { isTribeNameShape } from "tribe-wire/lib/persona-name"
import { evaluateAdapterRestart } from "./supervisor-policy.ts"
import { buildPluginAdapterEnvironment, PLUGIN_REEXEC_EXIT_CODE } from "./supervisor-environment.ts"

const PLUGIN_CHILD = "TRIBE_PLUGIN_ADAPTER_CHILD"
const PLUGIN_PROVIDER_PARENT_PID = "TRIBE_PLUGIN_PROVIDER_PARENT_PID"
const REEXEC_EXIT_CODE = PLUGIN_REEXEC_EXIT_CODE
const REEXEC_JOINED_OFFSET = 1
const GENERATION_REEXEC_OFFSET = 2
const LAST_REEXEC_EXIT_CODE = REEXEC_EXIT_CODE + GENERATION_REEXEC_OFFSET + REEXEC_JOINED_OFFSET
const REMEDY =
  "tribe plugin adapter supervision exhausted its bounded restart budget; run /mcp reconnect after repairing the reported cause or reinstall the Tribe plugin."
const PROVIDER_PARENT_REMEDY =
  "tribe plugin wrapper requires valid provider-parent provenance from a complete live managed launch; restart the host session or reinstall the Tribe plugin."
const LEGACY_PARENT_WARNING =
  "tribe plugin wrapper: managed launch supplied no provider-parent PID; falling back to the wrapper's real provider parent. Relaunch the host session to restore full launch provenance."

function supervisedIdentity(message: unknown): { name: string; joined: boolean } | undefined {
  if (typeof message !== "object" || message === null || !("tribePluginIdentity" in message)) return undefined
  const identity = (message as { tribePluginIdentity?: unknown }).tribePluginIdentity
  if (typeof identity !== "object" || identity === null) return undefined
  const { name, joined } = identity as { name?: unknown; joined?: unknown }
  return typeof name === "string" && isTribeNameShape(name) && typeof joined === "boolean"
    ? { name, joined }
    : undefined
}

function waitForExit(
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }> {
  return new Promise((resolve) => {
    child.once("error", (error) => resolve({ code: null, signal: null, error }))
    child.once("exit", (code, signal) => resolve({ code, signal }))
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
  let reportedJoined = false
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
      env: buildPluginAdapterEnvironment(
        process.env,
        providerParentPid,
        canResumeJoined && resumeName !== undefined ? { name: resumeName } : undefined,
      ),
    })
    active.on("message", (message) => {
      const identity = supervisedIdentity(message)
      if (identity !== undefined) {
        resumeName = identity.name
        reportedJoined = identity.joined
      }
    })
    const result = await waitForExit(active)
    active = null
    if (stopping) return
    if (!result.error && result.code === 0) {
      process.exitCode = 0
      return
    }

    const requestedReexec =
      result.code !== null && result.code >= REEXEC_EXIT_CODE && result.code <= LAST_REEXEC_EXIT_CODE
    let maxConsecutiveReexecs: number | undefined
    if (requestedReexec && result.code !== null) {
      const reexecOffset = result.code - REEXEC_EXIT_CODE
      resumeJoined = reexecOffset % GENERATION_REEXEC_OFFSET === REEXEC_JOINED_OFFSET
      const generationChange = reexecOffset >= GENERATION_REEXEC_OFFSET
      maxConsecutiveReexecs = generationChange ? undefined : 1
    } else {
      // The wrapper is the provider's stable stdio endpoint. An unexpected
      // adapter crash must not tear that endpoint down and require a human
      // /mcp reconnect. Preserve the adapter's last authoritative join state
      // and apply the same bounded backoff used for daemon-generation
      // replacements.
      resumeJoined = reportedJoined
    }
    const decision = evaluateAdapterRestart(consecutiveReexecs, Date.now() - startedAt, maxConsecutiveReexecs)
    consecutiveReexecs = decision.consecutiveReexecs
    if (!decision.retry) {
      const cause = result.error?.message ?? `exit=${String(result.code)} signal=${String(result.signal)}`
      process.stderr.write(`${REMEDY} (${cause})\n`)
      process.exitCode = 2
      return
    }
    if (!requestedReexec) {
      const cause = result.error?.message ?? `exit=${String(result.code)} signal=${String(result.signal)}`
      process.stderr.write(
        `tribe plugin adapter exited unexpectedly; retrying in ${decision.retryDelayMs}ms ` +
          `(attempt ${decision.consecutiveReexecs}, ${cause})\n`,
      )
    }
    await waitForRetry(decision.retryDelayMs)
  }
}

if (process.env[PLUGIN_CHILD] === "1") await import("tribe-wire/stdio")
else await superviseAdapter()
