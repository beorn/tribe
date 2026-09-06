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
 * The boot sequence reads top-down through the pipe(...) call below — that IS
 * the architecture. Each `withX` factory adds one capability to the daemon
 * value; cleanup registers on the root scope. See hub/composition.md for the
 * full strategy.
 */

import { parseArgs } from "node:util"
import { createLogger } from "loggily"
import { pipe, withTool, withTools, createScope, formatRuntimeId } from "tribe-wire"
import type { TribeAutostart } from "./lib/autostart-config.ts"
import { gitPlugin } from "./lib/git-plugin.ts"
import { githubPlugin } from "./lib/github-plugin.ts"
import { healthMonitorPlugin } from "./lib/health-monitor-plugin.ts"
import { accountlyPlugin } from "./lib/accountly-plugin.ts"
import type { TribePluginHandle } from "./lib/plugin-api.ts"

import {
  createBaseTribe,
  recallTools,
  messagingTools,
  probeAndCleanSocket,
  withBroadcast,
  withClientRegistry,
  withConfig,
  withDaemonContext,
  withDatabase,
  withDispatcher,
  withHotReload,
  reloadReplacementForEnvironment,
  withIdleQuit,
  withRecall,
  withMCPServer,
  withProjectRoot,
  withRuntime,
  withSignals,
  withSocketServer,
} from "./lib/compose/index.ts"
import { TOOLS_LIST } from "tribe-wire/lib/tools-list"
import { pruneOldActivityLogs } from "./lib/activity-log.ts"
import { countDurableSessionRows } from "./lib/session.ts"
import { gatherCodePin, STARTUP_SHA } from "./lib/code-pin.ts"
import { parseDeliveryFallbackPolicy } from "./lib/delivery-resolution.ts"
import { parseExpectedMembers } from "./lib/membership-declared-roster.ts"
import { sanitizeDaemonProcessEnvironment } from "../../wire/src/daemon-environment.ts"

// ---------------------------------------------------------------------------
// `daemon.ts hook <event>` — Claude Code hook entry point. This is the
// command `tribe install` plants in ~/.claude/settings.json (see
// lib/install.ts TRIBE_HOOK_MARKER). It must dispatch and EXIT before the
// daemon pipe below boots: a hook invocation never starts a broker
// in-process — dispatchHook owns standalone supervisor autostart itself.
// ---------------------------------------------------------------------------

if (process.argv[2] === "hook") {
  const HOOK_EVENTS = ["session-start", "prompt", "session-end", "pre-compact"] as const
  const event = process.argv[3] as (typeof HOOK_EVENTS)[number] | undefined
  if (!event || !HOOK_EVENTS.includes(event)) {
    process.stderr.write(`tribe-daemon hook: unknown event "${event ?? ""}" (expected ${HOOK_EVENTS.join("|")})\n`)
    process.exit(2)
  }
  const { dispatchHook } = await import("./lib/hook-dispatch.ts")
  await dispatchHook(event)
  process.exit(0)
}

// ---------------------------------------------------------------------------
// `daemon.ts install|uninstall|doctor` — Claude Code setup automation. Wires
// the hooks `daemon.ts hook <event>` command into `~/.claude/settings.json`,
// the `tribe` MCP server into the project's `.mcp.json`, and the autostart
// mode file — see lib/install.ts for the plan/apply/doctor split (pure plan,
// then a separate write step so `--dry-run` is trivial). Same shape as the
// `hook` block above: dispatch and exit before the daemon pipe boots.
//
// This is a distinct diagnostic from `tribe-wire doctor` (which checks
// whether a RUNNING daemon's code is stale vs on-disk/pin). `doctor` here
// checks whether the Claude Code integration (hooks, MCP entry, autostart
// config) is wired up correctly — a different question, answered by
// lib/install.ts's doctorReport, that nothing else in this repo answers.
// ---------------------------------------------------------------------------

if (process.argv[2] === "install" || process.argv[2] === "uninstall" || process.argv[2] === "doctor") {
  const sub = process.argv[2]
  const { values: installArgs } = parseArgs({
    args: process.argv.slice(3),
    options: {
      "dry-run": { type: "boolean", default: false },
      autostart: { type: "string" },
    },
    strict: false,
  })

  const {
    defaultInstallEnv,
    planInstall,
    applyInstall,
    formatInstallPlan,
    planUninstall,
    applyUninstall,
    formatUninstallPlan,
    doctorReport,
    formatDoctorReport,
  } = await import("./lib/install.ts")
  const { VALID_AUTOSTART_MODES } = await import("./lib/autostart-config.ts")

  const env = defaultInstallEnv()
  const dryRun = Boolean(installArgs["dry-run"])

  if (sub === "install") {
    const autostartRaw = installArgs.autostart as string | undefined
    if (autostartRaw !== undefined && !VALID_AUTOSTART_MODES.includes(autostartRaw as TribeAutostart)) {
      process.stderr.write(
        `tribe-daemon install: --autostart must be one of ${VALID_AUTOSTART_MODES.join("|")}, got "${autostartRaw}"\n`,
      )
      process.exit(2)
    }
    const plan = planInstall(env, { autostart: autostartRaw as TribeAutostart | undefined })
    console.log(formatInstallPlan(plan, dryRun))
    if (!dryRun) applyInstall(plan)
    process.exit(0)
  }

  if (sub === "uninstall") {
    const plan = planUninstall(env)
    console.log(formatUninstallPlan(plan, dryRun))
    if (!dryRun) applyUninstall(plan)
    process.exit(0)
  }

  // doctor — read-only, exits non-zero when any check fails (loud by design;
  // scriptable in CI/health checks without parsing stdout).
  const report = await doctorReport(env)
  console.log(formatDoctorReport(report))
  process.exit(report.hasFailures ? 1 : 0)
}

sanitizeDaemonProcessEnvironment(process.env)

const log = createLogger("tribe:daemon")
const deliveryFallbackPolicy = parseDeliveryFallbackPolicy(process.env.TRIBE_DELIVERY_FALLBACKS)
const expectedMembers = parseExpectedMembers(process.env.TRIBE_EXPECTED_MEMBERS)

// ---------------------------------------------------------------------------
// Sync portion of the pipe — config, db, daemonCtx, recall, tools, registry,
// broadcast pipeline. Stops here so the alive-probe (async) can run before
// withSocketServer attempts to bind.
// ---------------------------------------------------------------------------

const rootScope = createScope("tribe-daemon")

const partialShape = pipe(
  createBaseTribe({ scope: rootScope, daemonVersion: "0.10.0" }),
  withConfig(),
  withProjectRoot(),
  withDatabase(),
  withDaemonContext(),
  withRecall(),
  withTools(),
  withTool(messagingTools()),
  withClientRegistry(),
  withBroadcast(),
)

// ---------------------------------------------------------------------------
// Async setup outside the pipe (per hub/composition.md § "Async — outside the
// pipe"). Probe an existing socket: if a live daemon owns it, exit; if it's
// stale, the function unlinks it so withSocketServer's bind() succeeds.
// ---------------------------------------------------------------------------

if (partialShape.config.inheritFd === null) {
  const alreadyAlive = await probeAndCleanSocket(partialShape.config.socketPath)
  if (alreadyAlive) {
    log.info?.(`Another daemon is already listening on ${partialShape.config.socketPath}, exiting`)
    process.exit(0)
  }
}

// One-shot retention sweep: remove activity-*.jsonl files older than 30 days.
// Best-effort; failures never block daemon startup. See @km/tribe/activity-log
// (acceptance criterion "Daily rotation at midnight, no event loss across
// rollover" implies bounded retention).
try {
  const removed = pruneOldActivityLogs(30)
  if (removed > 0) log.info?.(`activity-log retention: pruned ${removed} stale file(s)`)
} catch (err) {
  log.warn?.(`activity-log prune failed (non-fatal): ${String(err)}`)
}

// ---------------------------------------------------------------------------
// Bridges between later-in-the-pipe factories and earlier-in-the-pipe ones.
// withRuntime publishes plugin metadata + the shutdown callable; downstream
// factories (dispatcher, hot-reload, signals, idle-quit) call into them
// through these refs so the pipe stays linear.
//
// The refs are an artifact of "the only way to express forward references in
// a synchronous pipe is a mutable slot." Once withRuntime + withDispatcher
// share a serializable bus (TEA-style effect sink), the refs collapse.
// ---------------------------------------------------------------------------

const refs = {
  activePluginNames: [] as string[],
  pluginStatus: [] as TribePluginHandle[],
  stopPlugins: () => {},
  shutdown: () => {},
}

// ---------------------------------------------------------------------------
// Resume the pipe — socket bind → idle-quit → dispatcher → hot-reload →
// signals → runtime. Each factory's prerequisites are enforced by the
// type system; reading top-down IS the boot order.
// ---------------------------------------------------------------------------

const withSocketShape = withSocketServer<typeof partialShape>()(partialShape)
const socketBinding = withSocketShape.socket.binding
// Do not block composition on the listen callback: clients may connect as soon
// as the socket is bound, so the dispatcher must attach in this same turn.
// A losing candidate is notified asynchronously and exits after disposing its
// partial/full shape; it never reaches for the winner's socket path.
void socketBinding
  .then(async (binding) => {
    if (binding !== "occupied") return
    log.info?.(`Another daemon won the bind election for ${withSocketShape.socket.socketPath}, exiting`)
    await rootScope[Symbol.asyncDispose]()
    process.exit(0)
  })
  .catch(async (error: unknown) => {
    log.error?.(`Daemon socket bind failed: ${error instanceof Error ? error.message : String(error)}`)
    await rootScope[Symbol.asyncDispose]()
    process.exit(1)
  })
const withIdleQuitShape = withIdleQuit<typeof withSocketShape>({
  triggerShutdown: () => refs.shutdown(),
  // The census's DB half: registered sessions of any delivery mode count as
  // clients for the idle-quit decision (2026-08-12 — a fully-populated pull
  // fleet read as "no clients" and the rail self-quit).
  countDurableSessions: () => countDurableSessionRows(withSocketShape.db, deliveryFallbackPolicy?.retiredNames),
})(withSocketShape)
const withDispatcherShape = withDispatcher<typeof withIdleQuitShape>({
  onActiveClient: () => withIdleQuitShape.idleQuit.markActive(),
  onIdle: () => withIdleQuitShape.idleQuit.markIdle(),
  getActivePluginNames: () => refs.activePluginNames,
  getPluginStatus: () => refs.pluginStatus,
  getIdleQuitAfterSec: () => withSocketShape.config.idleQuitAfterSec,
  // tribe.stop: clean shutdown (drain, close socket, exit 0), no successor.
  triggerShutdown: () => refs.shutdown(),
  resolveDelivery: deliveryFallbackPolicy?.resolveDelivery,
  retiredNames: deliveryFallbackPolicy?.retiredNames,
  expectedMembers,
})(withIdleQuitShape)
// MCP-spec surface — reads the tool registry, registers initialize / tools/list
// / tools/call on the dispatcher. tools/call routes through the dispatcher's
// JSON-RPC handler when possible (preserves per-connection context wired up
// by withDispatcher), then falls back to the tool's registry handler.
const withMCPShape = withMCPServer<typeof withDispatcherShape>({
  metadata: TOOLS_LIST.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    // MCP outputSchema — paired with handler `structuredContent` emission.
    // Tools published before @km/infra/15623 lacked outputSchema; the
    // post-15623 TOOLS_LIST entries declare it for every tool.
    outputSchema: t.outputSchema,
  })),
  dispatch: async (toolName, args, ctx) => {
    // Route every other registered tool through the dispatcher's handleRequest.
    // The dispatcher's tribe.* / recall cases own connection context; for
    // unknown methods it returns -32601 which we surface as an MCP error.
    if (!withDispatcherShape.tools.has(toolName)) return undefined
    const responseLine = await withDispatcherShape.dispatcher.handleRequest(
      { jsonrpc: "2.0", id: `mcp-${ctx.connId}-${Date.now()}`, method: toolName, params: args },
      ctx.connId,
    )
    const parsed = JSON.parse(responseLine.trimEnd()) as
      | { result: unknown; error?: undefined }
      | { error: { code: number; message: string }; result?: undefined }
    if ("error" in parsed && parsed.error) {
      const err = new Error(parsed.error.message) as Error & { code: number }
      err.code = parsed.error.code
      throw err
    }
    return parsed.result
  },
})(withDispatcherShape)
const withHotReloadShape = withHotReload<typeof withMCPShape>({
  stopPlugins: () => refs.stopPlugins(),
  triggerShutdown: () => refs.shutdown(),
  replaceProcess: reloadReplacementForEnvironment(process.env, () => refs.shutdown()),
})(withMCPShape)
// Confirm withMCPShape carries the MCP server handle (for tests / status).
log.debug?.(
  `MCP server ready: ${withMCPShape.mcpServer.toolNames.length} tools, protocol ${withMCPShape.mcpServer.protocolVersion}`,
)

const withSignalsShape = withSignals<typeof withHotReloadShape>({
  onShutdown: () => refs.shutdown(),
  onReload: () => withHotReloadShape.hotReload.reload(),
})(withHotReloadShape)
const tribe = withRuntime<typeof withSignalsShape>({
  plugins: process.env.TRIBE_NO_PLUGINS ? [] : [gitPlugin, githubPlugin, healthMonitorPlugin, accountlyPlugin],
  publishActivePluginNames: (n) => {
    refs.activePluginNames = n
  },
  publishPluginStatus: (handles) => {
    refs.pluginStatus = handles
  },
  publishStopPlugins: (fn) => {
    refs.stopPlugins = fn
  },
  publishShutdown: (fn) => {
    refs.shutdown = fn
  },
})(withSignalsShape)

// Recall tools are conditional on recall being enabled — register them after the
// pipe so the registry stays append-only when --no-recall is set. The dispatcher
// reads the registry lazily, so late registration is safe.
if (tribe.recall) {
  for (const t of recallTools(tribe.recall)) tribe.tools.set(t.name, t)
}

// Loud startup identity: name the version+sha THIS process loaded so a stale
// long-lived daemon is visible at a glance, not only on the code-pin stale path
// below (@km/infra/20359). STARTUP_SHA is frozen at module import = process start.
log.info?.(`tribe daemon ${formatRuntimeId(tribe.daemonVersion, STARTUP_SHA ? STARTUP_SHA.slice(0, 12) : null)}`)
log.info?.(`Starting tribe daemon`)
log.info?.(`Socket: ${tribe.config.socketPath}`)
log.info?.(`DB: ${tribe.config.dbPath}`)
log.info?.(`PID: ${process.pid}`)
if (tribe.recall) log.info?.(`Recall DB: ${tribe.config.recallDbPath}`)
log.info?.(`Daemon ready (pid=${process.pid}, clients=${tribe.registry.clients.size})`)

// Stale-code startup guard (@km/tribe/20033). At startup running == on-disk
// (just captured), so this fires on the "autostarting from a dirty submodule"
// case (on-disk != superproject pin). The running != on-disk case (checkout
// advanced under a long-lived daemon) is surfaced over the process lifetime via
// tribe.health()'s `code_pin`. Loud, non-fatal: a dirty pin must not autostart
// silently, but we don't brick a deliberate standalone/dev run.
{
  const codePin = gatherCodePin()
  if (codePin.stale) {
    log.warn?.(
      `STALE DAEMON CODE (@km/tribe/20033): ${codePin.reason} ` +
        `[running=${codePin.running ?? "?"} on_disk=${codePin.on_disk ?? "?"} pin=${codePin.superproject_pin ?? "?"}]`,
    )
  } else {
    log.debug?.(`code pin ok (running=${codePin.running ?? "unknown"})`)
  }
}

// ---------------------------------------------------------------------------
// Run loop — resolves when the daemon's scope aborts (shutdown / SIGTERM /
// SIGINT / hot-reload / idle-quit / fatal). Aligns with silvery's run(view, …)
// and the era2 lifecycle.
// ---------------------------------------------------------------------------

await tribe.run()
