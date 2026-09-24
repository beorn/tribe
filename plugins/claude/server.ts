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
import { evaluateAdapterRestart, PROVIDER_PARENT_REMEDY, resolveProviderParentPid } from "./supervisor-policy.ts"
import { buildPluginAdapterEnvironment, PLUGIN_REEXEC_EXIT_CODE } from "./supervisor-environment.ts"
import { recordAdapterExit, resolveAdapterExitRecord } from "./supervisor-exit-record.ts"

const PLUGIN_CHILD = "TRIBE_PLUGIN_ADAPTER_CHILD"
const REEXEC_EXIT_CODE = PLUGIN_REEXEC_EXIT_CODE
const REEXEC_JOINED_OFFSET = 1
const GENERATION_REEXEC_OFFSET = 2
const LAST_REEXEC_EXIT_CODE = REEXEC_EXIT_CODE + GENERATION_REEXEC_OFFSET + REEXEC_JOINED_OFFSET
const REMEDY =
  "tribe plugin adapter refused a repeated deterministic replacement; run /mcp reconnect after repairing the reported cause or reinstall the Tribe plugin."

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

async function superviseAdapter(): Promise<void> {
  // The wrapper is an implementation detail between the provider host and
  // the adapter. A managed Hab launch supplies the authoritative harness PID;
  // a standalone plugin uses the wrapper's actual provider parent. Capture the
  // resolved boundary once so every child/re-exec reports one logical owner.
  let providerParentPid: number
  try {
    providerParentPid = resolveProviderParentPid(process.env, process, processExists, (line) =>
      process.stderr.write(`${line}\n`),
    )
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
  const exitRecord = resolveAdapterExitRecord(process.env)
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
    const stdio: Array<"inherit" | "ignore" | "ipc" | number> = ["inherit", "inherit", "inherit", "ipc"]
    active = spawn(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
      stdio,
      env: buildPluginAdapterEnvironment(
        process.env,
        providerParentPid,
        canResumeJoined && resumeName !== undefined ? { name: resumeName } : undefined,
        exitRecord.path,
      ),
    })
    active.on("message", (message) => {
      const identity = supervisedIdentity(message)
      if (identity !== undefined) {
        resumeName = identity.name
        reportedJoined = identity.joined
      }
    })
    const adapterPid = active.pid
    const result = await waitForExit(active)
    active = null
    const exit = { adapterPid, code: result.code, signal: result.signal, error: result.error }
    if (stopping) {
      recordAdapterExit(exitRecord, { ...exit, decision: "host-stop" })
      return
    }
    // Code 0 means only that the host closed the adapter's stdin: a replacement
    // would inherit fd 0 at EOF, so this endpoint is done. A signal aimed at the
    // child alone exits 128+signo and takes the retry path below (25661).
    if (!result.error && result.code === 0) {
      recordAdapterExit(exitRecord, { ...exit, decision: "clean-exit" })
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
      maxConsecutiveReexecs = generationChange ? Number.POSITIVE_INFINITY : 1
    } else {
      // The wrapper is the provider's stable stdio endpoint. An unexpected
      // adapter crash must not tear that endpoint down and require a human
      // /mcp reconnect. Preserve the adapter's last authoritative join state
      // and apply the same capped, jittered backoff used for daemon-generation
      // replacements. The retry count is deliberately unbounded: this wrapper
      // is the provider's only MCP endpoint, so exhausting it converts a child
      // fault into a permanent `Transport closed` for the live host session.
      resumeJoined = reportedJoined
      maxConsecutiveReexecs = Number.POSITIVE_INFINITY
    }
    const decision = evaluateAdapterRestart(
      consecutiveReexecs,
      Date.now() - startedAt,
      maxConsecutiveReexecs,
      Math.random(),
    )
    consecutiveReexecs = decision.consecutiveReexecs
    recordAdapterExit(exitRecord, {
      ...exit,
      decision: decision.retry ? "retry" : "stop",
      attempt: decision.consecutiveReexecs,
      ...(decision.retry ? { retryDelayMs: decision.retryDelayMs } : {}),
    })
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
