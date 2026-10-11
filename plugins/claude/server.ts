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
import { readDaemonCodeView } from "tribe-wire/lib/code-identity"
import { parseTribeArgs } from "tribe-wire/lib/config-light"
import { resolveSocketPath } from "tribe-wire/lib/socket"
import { isTribeNameShape } from "tribe-wire/lib/persona-name"
import {
  adapterEntryForRoot,
  codeRootWaitWindowMs,
  evaluateAdapterRestart,
  evaluateCodeRootWait,
  PROVIDER_PARENT_REMEDY,
  resolveProviderParentPid,
} from "./supervisor-policy.ts"
import {
  buildPluginAdapterEnvironment,
  PLUGIN_PERSONA_REFUSAL_EXIT_CODE,
  PLUGIN_REEXEC_EXIT_CODE,
} from "./supervisor-environment.ts"
import { recordAdapterExit, resolveAdapterExitRecord } from "./supervisor-exit-record.ts"
import {
  newSupervisorToken,
  resolveSupervisorClaimPath,
  resolveSupervisorClaimPollMs,
  startSupervisorClaimWatch,
  writeSupervisorClaim,
  type SupervisorClaimWatch,
} from "./supervisor-claim.ts"
import { TRIBE_NAME_ENV, TRIBE_PLUGIN_ADAPTER_CHILD_ENV } from "tribe-wire/lib/session-identity-env"

const PLUGIN_CHILD = TRIBE_PLUGIN_ADAPTER_CHILD_ENV
const REEXEC_EXIT_CODE = PLUGIN_REEXEC_EXIT_CODE
const REEXEC_JOINED_OFFSET = 1
const GENERATION_REEXEC_OFFSET = 2
const LAST_REEXEC_EXIT_CODE = REEXEC_EXIT_CODE + GENERATION_REEXEC_OFFSET + REEXEC_JOINED_OFFSET
const REMEDY =
  "tribe plugin adapter refused a repeated deterministic replacement; run /mcp reconnect after repairing the reported cause or reinstall the Tribe plugin."
/** The same socket the adapter child resolves: this argv's `--socket`, else TRIBE_SOCKET, else the XDG default. */
const DAEMON_SOCKET_PATH = resolveSocketPath(parseTribeArgs().socket)

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

/**
 * Why the wait for the daemon's landing root ended. `stopped` and `unpublished` both carry no root, and the caller
 * must tell them apart: only `unpublished` is the cold-start refusal. A `resolved` root still needs one stop
 * re-check before the spawn, because a stop handler can run while the reply is already in flight (28380).
 */
type AdapterCodeRoot =
  | { readonly kind: "resolved"; readonly root: string }
  | { readonly kind: "stopped" }
  | { readonly kind: "unpublished" }

/**
 * The landing root the daemon publishes, waited for with one named stderr line per attempt (27531). A COLD START
 * gives up after the measured window, because the host is waiting on this process for its MCP handshake; a RESPAWN
 * never gives up, because the host's MCP endpoint has to survive a daemon that is merely restarting. BOTH waits end
 * on the supervisor's own stop condition (28380): `isStopping` is read before every attempt, so a stop that arrives
 * while this is parked on the daemon ends the retry instead of leaving the supervisor waiting behind a host that has
 * already gone.
 */
async function resolveAdapterCodeRoot(
  isFirstSpawn: () => boolean,
  isStopping: () => boolean,
): Promise<AdapterCodeRoot> {
  const windowMs = codeRootWaitWindowMs(process.env, (line) => process.stderr.write(`${line}\n`))
  const waitStartedAt = Date.now()
  let attempt = 0
  for (;;) {
    if (isStopping()) return { kind: "stopped" }
    let failure: string
    try {
      const view = await readDaemonCodeView(DAEMON_SOCKET_PATH)
      if (view.root !== null) return { kind: "resolved", root: view.root }
      failure = "the daemon answered but published no code root (daemon.code_identity.root absent)"
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }
    const decision = evaluateCodeRootWait(
      { firstSpawn: isFirstSpawn(), waitedMs: Date.now() - waitStartedAt, attempt },
      { windowMs },
    )
    process.stderr.write(
      `tribe plugin supervisor: no landing root to spawn the adapter from (${failure}); attempt ${attempt + 1}` +
        (decision.giveUp ? `; ${decision.reason}\n` : `, retrying in ${decision.retryDelayMs} ms\n`),
    )
    if (decision.giveUp) return { kind: "unpublished" }
    await waitForRetry(decision.retryDelayMs)
    attempt += 1
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
  let lastRetryDelayMs = 0
  let firstSpawn = true
  let resumeJoined = false
  let reportedJoined = false
  let claimWatch: SupervisorClaimWatch | null = null
  const exitRecord = resolveAdapterExitRecord(process.env)
  const launchName = process.env[TRIBE_NAME_ENV]?.trim()
  let resumeName = launchName && isTribeNameShape(launchName) ? launchName : undefined
  const forward = (signal: NodeJS.Signals) => {
    stopping = true
    claimWatch?.stop()
    active?.kill(signal)
  }
  process.once("SIGINT", () => forward("SIGINT"))
  process.once("SIGTERM", () => forward("SIGTERM"))

  // #27459 gap-5 - claim this launch's supervisor slot. A host can spawn a new
  // MCP supervisor without closing the old stdio pipe; the old adapter then
  // never sees EOF and the old pair lingers for days. The newest supervisor
  // takes the claim over on its own start, and this one yields on the next poll.
  const claimPath = resolveSupervisorClaimPath(process.env)
  if (claimPath !== null) {
    const token = newSupervisorToken()
    try {
      writeSupervisorClaim(claimPath, { token, pid: process.pid, atMs: Date.now() })
      claimWatch = startSupervisorClaimWatch({
        path: claimPath,
        token,
        pollMs: resolveSupervisorClaimPollMs(process.env),
        onSuperseded: () => {
          process.stderr.write(
            "tribe plugin supervisor: a newer supervisor for this launch took over the claim; exiting\n",
          )
          forward("SIGTERM")
        },
      })
    } catch (error) {
      // NO SILENT ERRORS: no claim means no takeover, and the reason is named.
      process.stderr.write(
        `tribe plugin supervisor: could not claim ${claimPath} ` +
          `(${error instanceof Error ? error.message : String(error)}); a superseded supervisor will not yield\n`,
      )
    }
  }

  while (!stopping) {
    const startedAt = Date.now()
    const resolution = await resolveAdapterCodeRoot(
      () => firstSpawn,
      () => stopping,
    )
    if (resolution.kind === "unpublished") {
      process.stderr.write(
        "tribe plugin supervisor: refused to start the adapter without a daemon-published landing root; " +
          "the host session needs a running tribe daemon (exit 2)\n",
      )
      process.exitCode = 2
      return
    }
    // A stop handler may have run while that reply was in flight, and neither the wait nor this path used to look
    // (28380): a child born now would outlive the host that just went away, and the forwarded signal has no active
    // child to reach. The stop is named, because a supervisor that quits without a line is a silent error.
    if (resolution.kind === "stopped" || stopping) {
      process.stderr.write(
        "tribe plugin supervisor: stop observed while waiting for the daemon's landing root; no adapter was started\n",
      )
      return
    }
    const codeRoot = resolution.root
    const canResumeJoined = resumeJoined && resumeName !== undefined
    const stdio: Array<"inherit" | "ignore" | "ipc" | number> = ["inherit", "inherit", "inherit", "ipc"]
    active = spawn(process.execPath, [adapterEntryForRoot(codeRoot), ...process.argv.slice(2)], {
      stdio,
      env: buildPluginAdapterEnvironment(
        process.env,
        providerParentPid,
        canResumeJoined && resumeName !== undefined ? { name: resumeName } : undefined,
        exitRecord.path,
      ),
    })
    firstSpawn = false
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
    if (!result.error && result.code === PLUGIN_PERSONA_REFUSAL_EXIT_CODE) {
      // The adapter already printed the daemon's repair message. This exit is
      // reserved for that decided refusal, so neither retry nor print again.
      recordAdapterExit(exitRecord, { ...exit, decision: "stop" })
      process.exitCode = 2
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
      lastRetryDelayMs,
      Date.now() - startedAt,
      maxConsecutiveReexecs,
    )
    consecutiveReexecs = decision.consecutiveReexecs
    lastRetryDelayMs = decision.retryDelayMs
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
  claimWatch?.stop()
}

if (process.env[PLUGIN_CHILD] === "1") await import("tribe-wire/stdio")
else await superviseAdapter()
