/**
 * Send/messaging verbs for the unified `tribe-wire` CLI.
 *
 * Family 2 of Phase A.2 verb-port — see
 * `@km/bearly/19231-tribe-cli-unify-phase-a2-verbs`. Each verb mirrors the
 * implementation in `vendor/tribe/tools/tribe-cli.ts` (which stays canonical
 * until the Phase C atomic-delete). The handlers here are pure ports — same
 * RPCs, same flags, same output shape — with the only changes being:
 *
 *   - Import paths are intra-package (`../lib/...`) instead of
 *     `tribe-wire/lib/...` (to avoid self-import).
 *   - The `retro.ts` module was copied into `../lib/retro.ts` so this module
 *     has no `tools/` dependency. It still uses DB-direct access (read-only
 *     `bun:sqlite`) — straddles client/daemon boundary; Phase C may revisit.
 *   - The verbs are registered on a caller-supplied `Command` rather than
 *     created on a fresh `program` — the main dispatcher (`cli.ts`) calls
 *     `registerSendCommands(program)` to wire them up.
 *
 * Verbs in this family:
 *   - send          (line ~581 in tools/tribe-cli.ts)
 *   - join          one-shot CLI join/rejoin checkpoint
 *   - alarm <reason>(line ~629)
 *   - alarm-status  (line ~635)
 *   - alarm-ack     (line ~641)
 *   - retro         (line ~646)
 */

import { existsSync } from "node:fs"
import type { Command } from "@silvery/commander"
import {
  cliArgument,
  cliOption,
  TRIBE_DELIVERY_MODES,
  TRIBE_FANOUTS,
  TRIBE_MESSAGE_TYPES,
  visibleCliProjectionForMcp,
  type TribeFanout as Fanout,
  type TribeMessageType as MessageType,
} from "../command-descriptors.ts"
import { connectToDaemon, resolveSocketPath, TRIBE_PROTOCOL_VERSION } from "../lib/socket.ts"
import { resolveDbPath } from "../lib/config.ts"
import { formatMarkdown, generateRetro, parseDuration } from "../lib/retro.ts"

const SEND_CLI = visibleCliProjectionForMcp("send")
const JOIN_CLI = visibleCliProjectionForMcp("join")

// ---------------------------------------------------------------------------
// Daemon connection (shared shape with read.ts — kept local per
// intra-module rule; Phase C may extract to ../lib/daemon-call.ts)
// ---------------------------------------------------------------------------

async function callDaemon(method: string, params?: Record<string, unknown>): Promise<unknown> {
  const socketPath = resolveSocketPath()
  try {
    const client = await connectToDaemon(socketPath)
    try {
      const result = await client.call(method, params)
      return result
    } finally {
      client.close()
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ECONNREFUSED" || code === "ENOENT") {
      console.error(`No daemon running (socket: ${socketPath})`)
      console.error(`Start one with: bun tribe-daemon (package tribe-daemon), or let a host autostart it`)
      process.exit(1)
    }
    throw err
  }
}

/**
 * Unwrap an MCP tool result's JSON content (`content[0].text` -> parsed), or
 * return the raw value when there is no parseable content. Local copy for the
 * send/messaging verb family until the CLI-daemon seam is extracted.
 */
function mcpJsonContent(raw: unknown): unknown {
  const text = (raw as { content?: ReadonlyArray<{ text?: string }> })?.content?.[0]?.text
  if (typeof text === "string") {
    try {
      return JSON.parse(text)
    } catch {
      /* not JSON - fall back to the raw value */
    }
  }
  return raw
}

/** Thin wrapper so `retro` uses the same DB resolution as the daemon. */
function resolveDbPathFromCli(): string {
  return resolveDbPath({})
}

// ---------------------------------------------------------------------------
// Message-type contract — shared with the daemon validator (kept in lockstep
// with the legacy `tools/tribe-cli.ts` definition; do not drift).
// ---------------------------------------------------------------------------

type SendPayloadInput = {
  to: string
  message: string
  type?: MessageType
  summary?: string
  request?: boolean | string
  reply?: string
  fanout?: Fanout
}

type SendPayload = {
  to: string
  message: string
  type: MessageType
  summary?: string
  request?: true | string
  reply?: string
  fanout?: Fanout
}

export function buildSendPayload(input: SendPayloadInput): SendPayload {
  const payload: SendPayload = {
    to: input.to,
    message: input.message,
    type: input.type ?? "notify",
  }
  if (input.summary) payload.summary = input.summary
  if (input.request !== undefined && input.request !== false) payload.request = input.request
  if (input.reply) payload.reply = input.reply
  if (input.fanout) payload.fanout = input.fanout
  return payload
}

function collectDomain(value: string, previous: string[]): string[] {
  return [...previous, value]
}

function parseDomains(values: string[] | undefined): string[] {
  return (values ?? [])
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean)
}

// ---------------------------------------------------------------------------
// Command implementations (ported verbatim from tools/tribe-cli.ts)
// ---------------------------------------------------------------------------

async function cmdSend(input: SendPayloadInput): Promise<void> {
  const result = (await callDaemon("tribe.send", buildSendPayload(input))) as {
    summary?: string
    summary_derived?: boolean
    warning?: string
  }
  console.log(`Sent message to ${input.to}`)
  // Derive-not-reject: surface (no-silent) when the daemon derived a one-liner
  // because none was authored, so the sender learns to pass `--summary`.
  if (result.summary_derived) {
    console.warn(`  no --summary given; derived one-liner: "${result.summary ?? ""}"`)
  }
}

async function cmdJoin(
  name: string,
  opts: { role?: string; domain?: string[]; delivery?: string; json?: boolean },
): Promise<void> {
  const delivery = opts.delivery ?? "pull"
  if (!(TRIBE_DELIVERY_MODES as readonly string[]).includes(delivery)) {
    console.error(`tribe-wire join: invalid --delivery '${delivery}' — expected ${TRIBE_DELIVERY_MODES.join("|")}`)
    process.exit(2)
  }

  const cwd = process.cwd()
  const role = opts.role ?? "member"
  const domains = parseDomains(opts.domain)
  const socketPath = resolveSocketPath()
  const ephemeralName = `cli-join-${process.pid}-${Date.now()}`
  let result: {
    joined?: boolean
    name?: string
    role?: string
    domains?: string[]
    delivery?: string
    previous_name?: string
    error?: string
  }
  try {
    const client = await connectToDaemon(socketPath)
    try {
      await client.call("register", {
        name: ephemeralName,
        role: "member",
        domains: [],
        delivery,
        project: cwd,
        projectName: cwd.split("/").filter(Boolean).at(-1) ?? "unknown",
        pid: process.pid,
        protocolVersion: TRIBE_PROTOCOL_VERSION,
      })
      result = mcpJsonContent(await client.call("tribe.join", { name, role, domains, delivery })) as typeof result
    } finally {
      client.close()
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ECONNREFUSED" || code === "ENOENT") {
      console.error(`No daemon running (socket: ${socketPath})`)
      console.error(`Start one with: bun tribe-daemon (package tribe-daemon), or let a host autostart it`)
      process.exit(1)
    }
    throw err
  }

  if (opts.json) {
    console.log(JSON.stringify(result))
    return
  }
  if (result.error) {
    console.error(`tribe-wire join: ${result.error}`)
    process.exit(1)
  }
  console.log(`Joined ${result.name ?? name} as ${result.role ?? role} (delivery=${result.delivery ?? delivery}).`)
  if (result.previous_name) console.log(`  previous: ${result.previous_name}`)
}

/**
 * Andon-pull alarm — `tribe alarm <reason>` sets a project-wide stop-the-line
 * flag. The chief-drain-check.sh PreToolUse hook reads it and HARD-BLOCKS
 * chief's tool calls until `tribe alarm-ack` clears it.
 * Spec: @km/all/silent-errors-enforcement/chief-silent-watchdog-relay-pattern-detection (Layer 3).
 */
async function cmdAlarmSet(reason: string, opts: { by?: string }): Promise<void> {
  const by = opts.by ?? process.env.USER ?? "anonymous"
  const result = (await callDaemon("cli_alarm_set", { reason, by })) as { ok: boolean }
  if (!result.ok) {
    console.error("tribe alarm: daemon refused")
    process.exit(1)
  }
  console.log(`ALARM SET — chief tool calls will block until 'tribe alarm-ack' is run.`)
  console.log(`  Reason: ${reason}`)
  console.log(`  By:     ${by}`)
}

async function cmdAlarmStatus(opts: { json?: boolean }): Promise<void> {
  const result = (await callDaemon("cli_alarm_get")) as
    | { active: false }
    | { active: true; reason: string; by: string; ts: number; age_min: number }
  if (opts.json) {
    console.log(JSON.stringify(result))
    return
  }
  if (!result.active) {
    console.log("No alarm active.")
    return
  }
  console.log(`ALARM ACTIVE (${result.age_min}min):`)
  console.log(`  Reason: ${result.reason}`)
  console.log(`  By:     ${result.by}`)
}

async function cmdAlarmAck(): Promise<void> {
  const result = (await callDaemon("cli_alarm_ack")) as { ok: boolean }
  if (!result.ok) {
    console.error("tribe alarm-ack: daemon refused")
    process.exit(1)
  }
  console.log("ALARM CLEARED — chief tool calls unblocked.")
}

async function cmdRetro(opts: { since?: string; format: string; db?: string }): Promise<void> {
  // Use the shared resolver so retro follows the same `--db > TRIBE_DB > XDG
  // > legacy migration` priority as the daemon. Before this fix, retro
  // hardcoded `.beads/tribe.db`, which breaks on fresh installs after the
  // km-tribe.decouple-db-location migration.
  const dbPath = opts.db ?? resolveDbPathFromCli()
  if (!existsSync(dbPath)) {
    console.error(`No tribe database found at ${dbPath}`)
    process.exit(1)
  }

  const { Database } = await import("bun:sqlite")
  const db = new Database(dbPath, { readonly: true })
  db.run("PRAGMA busy_timeout = 5000")
  let sinceMs: number | undefined
  if (opts.since) {
    try {
      sinceMs = parseDuration(opts.since)
    } catch (err) {
      console.error(String(err))
      process.exit(1)
    }
  }
  const report = generateRetro(db, sinceMs)
  console.log(opts.format === "json" ? JSON.stringify(report, null, 2) : formatMarkdown(report))
  db.close()
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register send/messaging verbs (Family 2 of Phase A.2 verb-port).
 * Each verb mirrors the implementation in `vendor/tribe/tools/tribe-cli.ts`.
 *
 * Bead: @km/bearly/19231-tribe-cli-unify-phase-a2-verbs
 */
export function registerSendCommands(program: Command): void {
  const sendTo = cliArgument(SEND_CLI, "to")
  const sendMessage = cliArgument(SEND_CLI, "message")
  const sendType = cliOption(SEND_CLI, "type")
  const sendSummary = cliOption(SEND_CLI, "summary")
  const sendReply = cliOption(SEND_CLI, "reply")
  const sendRequest = cliOption(SEND_CLI, "request")
  const sendFanout = cliOption(SEND_CLI, "fanout")
  program
    .command(SEND_CLI.name)
    .description(SEND_CLI.description)
    .argument(`<${sendTo.name}>`, sendTo.description)
    .argument(`<${sendMessage.name}...>`, sendMessage.description)
    .option(sendType.flags, sendType.description)
    .option(sendSummary.flags, sendSummary.description)
    .option(sendReply.flags, sendReply.description)
    .option(sendRequest.flags, sendRequest.description)
    .option(sendFanout.flags, sendFanout.description)
    .action(
      (
        to: string,
        message: string[],
        opts: { type?: string; summary?: string; request?: boolean | string; reply?: string; fanout?: string },
      ) => {
        const type = opts.type ?? "notify"
        if (!(TRIBE_MESSAGE_TYPES as readonly string[]).includes(type)) {
          console.error(
            `tribe-wire send: invalid --type '${type}' — expected one of: ${TRIBE_MESSAGE_TYPES.join(", ")}`,
          )
          process.exit(2)
        }
        if (opts.fanout !== undefined && !(TRIBE_FANOUTS as readonly string[]).includes(opts.fanout)) {
          console.error(
            `tribe-wire send: invalid --fanout '${opts.fanout}' — expected one of: ${TRIBE_FANOUTS.join(", ")}`,
          )
          process.exit(2)
        }
        void cmdSend({
          to,
          message: message.join(" "),
          type: type as MessageType,
          summary: opts.summary,
          request: opts.request === false ? undefined : opts.request,
          reply: opts.reply,
          fanout: opts.fanout as Fanout | undefined,
        })
      },
    )

  const joinName = cliArgument(JOIN_CLI, "name")
  const joinRole = cliOption(JOIN_CLI, "role")
  const joinDomain = cliOption(JOIN_CLI, "domain")
  const joinDelivery = cliOption(JOIN_CLI, "delivery")
  const joinJson = cliOption(JOIN_CLI, "json")
  program
    .command(JOIN_CLI.name)
    .description(JOIN_CLI.description)
    .argument(`<${joinName.name}>`, joinName.description)
    .option(joinRole.flags, joinRole.description, joinRole.default)
    .option(joinDomain.flags, joinDomain.description, collectDomain, [] as string[])
    .option(joinDelivery.flags, joinDelivery.description, joinDelivery.default)
    .option(joinJson.flags, joinJson.description)
    .action(
      (name: string, opts: { role?: string; domain?: string[]; delivery?: string; json?: boolean }) =>
        void cmdJoin(name, opts),
    )

  program
    .command("alarm <reason>")
    .description("Andon-pull stop-the-line — blocks chief tool calls until 'alarm-ack' (Layer 3)")
    .option("--by <name>", "Set the author of the alarm (default: $USER)")
    .action((reason: string, opts: { by?: string }) => void cmdAlarmSet(reason, opts))

  program
    .command("alarm-status")
    .description("Show current andon-pull alarm state (active reason + age, or 'no alarm active')")
    .option("--json", "Emit machine-readable JSON (for hooks)")
    .action((opts: { json?: boolean }) => void cmdAlarmStatus(opts))

  program
    .command("alarm-ack")
    .description("Clear the andon-pull alarm — unblocks chief tool calls")
    .action(() => void cmdAlarmAck())

  program
    .command("retro")
    .description("Generate retrospective report — metrics, timeline, coordination health")
    .option("-s, --since <duration>", "Time window (e.g. 2h, 30m, 1d)")
    .option("-f, --format <fmt>", "Output format: markdown or json", "markdown")
    .option("--db <path>", "Path to tribe.db (default: auto-detect)")
    .action(
      (opts: { since?: string; format?: string; db?: string }) =>
        void cmdRetro({ since: opts.since, format: opts.format ?? "markdown", db: opts.db }),
    )
}
