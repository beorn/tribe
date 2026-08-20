/**
 * Send/messaging verbs for the unified `tribe-wire` CLI.
 *
 * This is the shipping implementation for the send/messaging command family.
 * The unified dispatcher (`cli.ts`) registers these handlers on its shared
 * `Command` instance.
 *
 * Verbs in this family:
 *   - send
 *   - join          observe/checkpoint a persistent native join
 *   - alarm <reason>
 *   - alarm-status
 *   - alarm-ack
 *   - retro
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
  type TribeDeliveryMode as Delivery,
  type TribeFanout as Fanout,
  type TribeMessageType as MessageType,
} from "../command-descriptors.ts"
import { TRIBE_PROTOCOL_VERSION, TRIBE_SUPPORTED_PROTOCOL_VERSIONS } from "../lib/socket.ts"
import { resolveDbPath } from "../lib/config.ts"
import { INCIDENT_KEY_SEPARATOR, parseIncidentKey, type IncidentIdentity } from "../lib/incident.ts"
import { formatMarkdown, generateRetro, parseDuration } from "../lib/retro.ts"
import { readTribeLaunchId } from "../launch-environment.ts"
import { withCliDaemonClient } from "./daemon-client.ts"
import { mcpJsonContent } from "./mcp-json-content.ts"
import { oversizedMessageError } from "../lib/send-validation.ts"

const SEND_CLI = visibleCliProjectionForMcp("send")
const JOIN_CLI = visibleCliProjectionForMcp("join")

// ---------------------------------------------------------------------------
// Identity-aware calls over the shared CLI daemon-client lifecycle
// ---------------------------------------------------------------------------

/**
 * Decide what the one-shot CLI does when the daemon did not grant the identity
 * it asked for. The daemon never lets a CLI steal a name held by a live session
 * — it dedupes to a different one — so a tracked reply sent under the deduped
 * identity DELIVERS the message but closes ZERO tracker rows. That silent
 * half-success (peer sees the answer, ball stays open forever) is the failure
 * this guards; a tracked reply must abort instead.
 */
export function classifyIdentityGrant(
  requested: string,
  assigned: string | undefined,
  requireIdentity: boolean,
): { ok: true } | { ok: false; fatal: boolean; message: string } {
  if (assigned === requested) return { ok: true }
  const who = assigned === undefined || assigned.length === 0 ? "an anonymous session" : `"${assigned}"`
  const base = `tribe-wire: could not take the identity "${requested}" — the daemon assigned ${who}, because that name is held by a live session.`
  if (requireIdentity) {
    return {
      ok: false,
      fatal: true,
      message:
        `${base}\nA tracked reply must be sent BY the ball's owner, so nothing was sent and the ball is still open.\n` +
        `Answer from that live session's own Tribe MCP (tribe.send with the reply field) instead of the one-shot CLI.`,
    }
  }
  return { ok: false, fatal: false, message: `${base} This message is attributed to ${who}.` }
}

/**
 * The identity a one-shot CLI send registers under. `name` is the resolved
 * session/persona; for a MANAGED launch, `launchId`/`launchParentPid` carry the
 * daemon-authoritative launch tuple so the connection fans into the live seat
 * of that launch instead of colliding on the name. A bare TRIBE_NAME caller
 * omits the launch fields.
 */
type SendCaller = { name: string; launchId?: string; launchParentPid?: number }

async function callDaemon(
  method: string,
  params?: Record<string, unknown>,
  as?: SendCaller | null,
  requireIdentity = false,
): Promise<unknown> {
  return withCliDaemonClient(async (client) => {
    // One-shot identity: register under the caller's session name BEFORE the
    // call so the daemon attributes the message (and can close ball-tracker
    // rows owned by that name) instead of an anonymous pending-* session.
    //
    // When the caller is a MANAGED launch, resolveSendCaller carries the
    // daemon-authoritative (launch_id, launch_parent_pid) tuple; forwarding
    // it lets the daemon fan this connection into the live seat of the same
    // launch (attributed, no takeover) rather than colliding on the persona
    // name. A one-shot cannot mint that tuple itself — the daemon minted it —
    // so this never lets an unrelated caller steal a name. For a bare
    // TRIBE_NAME caller (no launch), we omit it; the grant check below then
    // decides between fail-loud abort (tracked reply) and attributed warn.
    if (as) {
      const registered = mcpJsonContent(
        await client.call("register", {
          name: as.name,
          role: "member",
          domains: [],
          delivery: "pull",
          project: process.cwd(),
          projectName: process.cwd().split("/").filter(Boolean).at(-1) ?? "unknown",
          pid: process.pid,
          protocolVersion: TRIBE_PROTOCOL_VERSION - 1,
          supportedProtocolVersions: [...TRIBE_SUPPORTED_PROTOCOL_VERSIONS],
          ...(as.launchId !== undefined && as.launchParentPid !== undefined
            ? { launchId: as.launchId, launchParentPid: as.launchParentPid }
            : {}),
        }),
      ) as { name?: string }
      const grant = classifyIdentityGrant(as.name, registered?.name, requireIdentity)
      if (!grant.ok) {
        if (grant.fatal) {
          console.error(grant.message)
          process.exit(1)
        }
        console.warn(grant.message)
      }
    }
    return client.call(method, params)
  })
}

/** Thin wrapper so `retro` uses the same DB resolution as the daemon. */
function resolveDbPathFromCli(): string {
  return resolveDbPath({})
}

// ---------------------------------------------------------------------------
// Message-type contract — shared with the daemon validator; do not drift.
// ---------------------------------------------------------------------------

type SendPayloadInput = {
  to: string
  message: string
  type?: MessageType
  summary?: string
  messageId?: string
  delivery?: Delivery
  ref?: string
  request?: boolean | string
  reply?: string
  /** CLI control only; never forwarded to the daemon payload. */
  anonymous?: boolean
  fanout?: Fanout
  expiresInMs?: number
  /** Raw `--incident emitter:subject:condition` value. */
  incident?: string
  /** `--incident-cleared`: the condition no longer holds. */
  incidentCleared?: boolean
}

type SendPayload = {
  to: string
  message: string
  type: MessageType
  summary?: string
  message_id?: string
  delivery?: Delivery
  ref?: string
  request?: true | string
  reply?: string
  fanout?: Fanout
  expires_in_ms?: number
  incident?: IncidentIdentity & { active?: boolean }
}

export function buildSendPayload(input: SendPayloadInput): SendPayload {
  const payload: SendPayload = {
    to: input.to,
    message: input.message,
    type: input.type ?? "notify",
  }
  if (input.summary) payload.summary = input.summary
  if (input.messageId) payload.message_id = input.messageId
  if (input.delivery) payload.delivery = input.delivery
  if (input.ref) payload.ref = input.ref
  if (input.request !== undefined && input.request !== false) payload.request = input.request
  if (input.reply) payload.reply = input.reply
  if (input.fanout) payload.fanout = input.fanout
  if (input.expiresInMs !== undefined) payload.expires_in_ms = input.expiresInMs
  if (input.incident !== undefined) {
    // Parsed here rather than split inline so the CLI and the daemon share one
    // definition of a well-formed identity. A bad key fails at the CLI with the
    // shape named, instead of reaching the daemon as a mystery refusal.
    const identity = parseIncidentKey(input.incident)
    if (identity === null) {
      throw new Error(
        `--incident must be emitter${INCIDENT_KEY_SEPARATOR}subject${INCIDENT_KEY_SEPARATOR}condition with all three parts non-empty (got ${JSON.stringify(input.incident)})`,
      )
    }
    payload.incident = input.incidentCleared === true ? { ...identity, active: false } : identity
  } else if (input.incidentCleared === true) {
    // Clearing needs to know WHAT cleared; silently ignoring this would look
    // like a successful close while the ball stayed open.
    throw new Error(
      "--incident-cleared requires --incident <emitter:subject:condition> naming the condition that cleared",
    )
  }
  return payload
}

type PendingListResult = {
  error?: string
  pending?: Array<{
    request_id?: string
    message_id?: string
    recipient?: string
    sender?: string
    summary?: string
    status?: string
  }>
}

function replyOwnerFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const name = env.TRIBE_SESSION_NAME?.trim() || env.TRIBE_NAME?.trim() || ""
  return name.length > 0 ? name : null
}

function rejectUnstructuredMessageIntent(input: SendPayloadInput): void {
  const intent = /^\s*(reply|ref)=(\S+)/u.exec(input.message)
  if (intent === null) return
  const field = intent[1] === "reply" ? "reply" : "ref"
  const value = intent[2] ?? ""

  console.error(
    `tribe-wire send: message content begins with ${field}=${value}; structured intent must not be encoded as prose.`,
  )
  console.error(`Use --${field} ${value} and remove ${field}=${value} from the message content.`)
  process.exit(2)
}

async function resolveSendCaller(reply?: string, anonymous = false): Promise<SendCaller | null> {
  if (anonymous) return null
  const launchId = readTribeLaunchId(process.env)
  if (launchId) {
    let failure: string
    try {
      const persona = replyOwnerFromEnv()
      const status = mcpJsonContent(
        await callDaemon("cli_inbox_status_by_launch_v1", {
          launch_id: launchId,
          ...(persona === null ? {} : { persona }),
        }),
      ) as {
        session?: unknown
        launch_id?: unknown
        launch_parent_pid?: unknown
      }
      if (typeof status.session === "string" && status.session.length > 0) {
        const caller: SendCaller = { name: status.session }
        // The daemon owns the (launch_id, launch_parent_pid) tuple; forward it
        // verbatim so callDaemon can fan into the live seat of this launch.
        if (typeof status.launch_id === "string" && status.launch_id.length > 0) caller.launchId = status.launch_id
        if (
          typeof status.launch_parent_pid === "number" &&
          Number.isSafeInteger(status.launch_parent_pid) &&
          status.launch_parent_pid > 0
        ) {
          caller.launchParentPid = status.launch_parent_pid
        }
        return caller
      }
      failure = `daemon launch authority returned no current session for launch id ${launchId}`
    } catch (error) {
      failure = `cannot resolve launch identity ${launchId}: ${error instanceof Error ? error.message : String(error)}`
    }
    console.error(`tribe-wire send: ${failure}; not sending${reply ? ` --reply ${reply}` : ""}.`)
    console.error(
      reply
        ? `A tracked reply must be sent by the ball's owner. Inspect with: tribe pending --owner <owner>`
        : "Restore the managed seat identity, or pass --anonymous for an intentionally unattributed untracked message.",
    )
    process.exit(1)
  }

  // No launch authority. TRIBE_NAME / TRIBE_SESSION_NAME is a caller-authored
  // hint, never validated provenance (21717), so a plain send must not forward
  // it as identity — it stays an anonymous pending-* sender. Only --reply needs
  // it, to name the ball owner the response must close; register there so the
  // daemon can attribute the closure (a live holder still dedupes fail-loud, so
  // a running seat is never stolen by a one-shot).
  if (!reply) {
    console.error("tribe-wire send: no daemon-validated launch identity is available; not sending.")
    console.error(
      "Send from a managed Tribe seat, or pass --anonymous for an intentionally unattributed untracked message.",
    )
    process.exit(1)
  }
  const owner = replyOwnerFromEnv()
  if (owner) return { name: owner }
  console.error(
    `tribe-wire send: --reply ${reply} requires TRIBE_NAME or TRIBE_SESSION_NAME so the one-shot CLI can close the pending owner.`,
  )
  console.error(`Example: TRIBE_NAME=@chief tribe send <recipient> --type response --reply ${reply} <message>`)
  console.error(`Inspect ownership first: tribe pending --owner <owner>`)
  process.exit(2)
}

/**
 * Advisory only (22844): closing a ball and delivering its answer must never
 * be one coupled operation. A reply whose id is no longer owned STILL SENDS —
 * a seat that waited hours must get the content even when the bookkeeping
 * half has expired, been settled out-of-band, or aged past the tracker. The
 * close outcome is reported separately after delivery.
 */
async function warnPendingReplyOwner(owner: string, reply: string): Promise<void> {
  const pending = mcpJsonContent(await callDaemon("tribe.pending", { owner })) as PendingListResult
  if (pending.error) {
    console.error(`tribe-wire send: note — cannot verify pending request ${reply} for ${owner}: ${pending.error}`)
    console.error(`Sending anyway; the close outcome is reported after delivery.`)
    return
  }
  const hasRequest = (pending.pending ?? []).some((p) => p.request_id === reply || p.message_id === reply)
  if (!hasRequest) {
    console.error(`tribe-wire send: note — no pending request ${reply} is currently owned by ${owner}; sending anyway.`)
    console.error(`The close will report 0 rows; the recipient still gets the message.`)
  }
}

/**
 * Advisory only (22990): warn when a seat sends to someone who holds an open
 * ball THAT SEAT OWNS, without `--reply`.
 *
 * This tests a SHAPE, never content: "you owe this recipient an answer and
 * this message is not marked as one". It makes no judgement about whether the
 * text answers anything, which is exactly why it is safe — an auto-detect-a-
 * reply design could silently close a live obligation, and this cannot. Do not
 * "improve" it by inspecting the message.
 *
 * WARN, never refuse. Legitimate sends to someone you owe exist: a mid-work
 * status, an unrelated topic. Refusing there teaches people to route around
 * the check, which is worse than no check at all.
 *
 * HONEST SCOPE: this catches answered-but-never-released. It does nothing for
 * never-answered-at-all, which was the larger share of the ten overdue balls
 * on 2026-08-19. Latency and flag discipline are different failures.
 */
async function warnUnreleasedBallToRecipient(sender: string, recipient: string): Promise<void> {
  // A broadcast is not a targeted send; warning on every fan-out would fire
  // constantly once a seat is behind, which is when a warning is least welcome
  // and most likely to be tuned out.
  if (recipient === "*") return

  const pending = mcpJsonContent(await callDaemon("tribe.pending", { owner: sender })) as PendingListResult
  if (pending.error !== undefined && pending.error.length > 0) {
    // Stay quiet rather than cry wolf: an unreadable tracker is not evidence
    // of an unreleased ball. The reply path already reports read failures on
    // the branch where the answer depends on them.
    return
  }

  const owed = (pending.pending ?? []).filter((row) => row.sender === recipient && row.recipient === sender)
  if (owed.length === 0) return

  console.error(
    `tribe-wire send: note — you hold ${owed.length} open ball(s) from ${recipient} and this message carries no --reply.`,
  )
  for (const row of owed) {
    const id = row.request_id ?? row.message_id
    if (id === undefined || id.length === 0) continue
    const summary = row.summary !== undefined && row.summary.length > 0 ? row.summary : "(no summary recorded)"
    const expired = row.status === "expired" ? " [EXPIRED]" : ""
    console.error(`  ${id}${expired}  ${summary}`)
    console.error(`    close with: tribe send ${recipient} --type response --reply ${id} <your answer>`)
  }
  console.error(`Sending anyway — this is a note, not a refusal; a send to someone you owe is often legitimate.`)
}

/**
 * Runs strictly AFTER delivery (22844): every branch here reports on the
 * bookkeeping half of an already-sent response, so none may read as a
 * delivery failure. Exit 3 = delivered, close not confirmed — distinct from
 * 1 (not delivered) and 2 (identity/usage).
 */
function reportCommittedReplyTracker(
  owner: string,
  reply: string,
  tracker: { request_id?: string; closed?: number } | undefined,
): void {
  if (tracker === undefined) {
    console.error(
      `tribe-wire send: response DELIVERED, but the daemon returned no committed tracker proof for ${reply}.`,
    )
    console.error(`Verify current state with: tribe pending --owner ${owner}`)
    process.exit(3)
  }
  const closed = tracker.closed
  const canonicalRequestId = tracker.request_id
  if (
    typeof canonicalRequestId !== "string" ||
    canonicalRequestId.length === 0 ||
    typeof closed !== "number" ||
    !Number.isSafeInteger(closed) ||
    closed < 0
  ) {
    console.error(
      `tribe-wire send: response DELIVERED, but the daemon returned malformed committed tracker proof for ${reply} ` +
        `(expected a canonical request_id and a non-negative integer closed count).`,
    )
    console.error(`Verify current state with: tribe pending --owner ${owner}`)
    process.exit(3)
  }
  if (closed < 1) {
    console.error(
      `tribe-wire send: response DELIVERED, but its committed tracker result closed 0 rows for ${canonicalRequestId} ` +
        `(ball not currently owned — expired, settled out-of-band, or never tracked).`,
    )
    console.error(`Verify current state with: tribe pending --owner ${owner}`)
    process.exit(3)
  }
  console.log(`Closed ${closed} pending request row(s) for ${owner}: ${canonicalRequestId}`)
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
// Command implementations
// ---------------------------------------------------------------------------

async function cmdSend(input: SendPayloadInput): Promise<void> {
  rejectUnstructuredMessageIntent(input)
  const oversized = oversizedMessageError(input.message)
  if (oversized !== null) {
    console.error(`tribe-wire send: ${oversized}`)
    process.exit(2)
  }
  const type = input.type ?? "notify"
  const anonymousWouldTrack =
    input.reply !== undefined ||
    input.request !== undefined ||
    input.incident !== undefined ||
    input.incidentCleared === true ||
    type === "request" ||
    type === "query" ||
    type === "assign"
  if (input.anonymous && anonymousWouldTrack) {
    console.error(
      "tribe-wire send: --anonymous is limited to untracked messages; it cannot be combined with reply/request/incident tracking or request, query, or assign types.",
    )
    process.exit(2)
  }
  const caller = await resolveSendCaller(input.reply, input.anonymous)
  if (input.reply && caller) await warnPendingReplyOwner(caller.name, input.reply)
  else if (!input.reply && caller && !input.anonymous) await warnUnreleasedBallToRecipient(caller.name, input.to)

  const result = mcpJsonContent(await callDaemon("tribe.send", buildSendPayload(input), caller, !input.anonymous)) as {
    error?: string
    summary?: string
    summary_derived?: boolean
    warning?: string
    truncated?: boolean
    original_length?: number
    tracker?: { request_id?: string; closed?: number }
    delivery?: {
      state?: string
      original_target?: string
      recipient?: string
      reason?: string
    }
  }
  if (typeof result.error === "string" && result.error.length > 0) {
    console.error(`tribe-wire send: ${result.error}`)
    process.exit(1)
  }
  if (input.reply && caller) reportCommittedReplyTracker(caller.name, input.reply, result.tracker)
  if (result.delivery?.state === "bounced") {
    const { original_target: originalTarget, recipient, reason } = result.delivery
    if (
      typeof originalTarget !== "string" ||
      originalTarget.length === 0 ||
      typeof recipient !== "string" ||
      recipient.length === 0 ||
      typeof reason !== "string" ||
      reason.length === 0
    ) {
      console.error(
        `tribe-wire send: message DELIVERED, but the daemon returned malformed redirect proof for ${input.to}.`,
      )
      console.error("Inspect the recipient mailbox and daemon delivery policy before retrying.")
      process.exit(3)
    }
    console.log(`Sent message to ${recipient} (redirected from ${originalTarget}: ${reason})`)
  } else {
    console.log(`Sent message to ${input.to}`)
  }
  // Derive-not-reject: surface (no-silent) when the daemon derived a one-liner
  // because none was authored, so the sender learns to pass `--summary`.
  if (result.summary_derived) {
    console.warn(`  no --summary given; derived one-liner: "${result.summary ?? ""}"`)
  }
  // @ag/tribe/22497: the daemon caps messages and used to cut them silently, so
  // "Sent message to X" above could describe a mutilated send. Same no-silent
  // rule as the derived summary — the sender learns from its own terminal.
  if (result.truncated) {
    console.warn(
      `  message TRUNCATED: only the first 4096 of ${result.original_length ?? "?"} chars were delivered; resend the remainder or link the full text`,
    )
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

  const role = opts.role ?? "member"
  const domains = parseDomains(opts.domain)
  const result = (await callDaemon("cli_join", { name, role, domains, delivery })) as {
    joined?: boolean
    observed?: boolean
    name?: string
    role?: string
    domains?: string[]
    delivery?: string
    memberId?: string
    transportPids?: number[]
    error?: string
  }

  if (result.error) {
    console.error(`tribe-wire join: ${result.error}`)
    process.exit(1)
  }
  if (opts.json) {
    console.log(JSON.stringify(result))
    return
  }
  console.log(
    `Verified ${result.name ?? name} is persistently joined as ${result.role ?? role} ` +
      `(delivery=${result.delivery ?? delivery}).`,
  )
}

/**
 * Andon-pull alarm — `tribe alarm <reason>` sets a project-wide stop-the-line
 * flag. The chief-drain-check.sh PreToolUse hook reads it and HARD-BLOCKS
 * chief's tool calls until `tribe alarm-ack` clears it.
 * Delivery-attention lineage: @ag/tribe/21626-per-seat-inbox-staleness-alarm.
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
 * Register the shipping send/messaging verbs on the unified dispatcher.
 *
 * Bead: @km/bearly/19231-tribe-cli-unify-phase-a2-verbs
 */
export function registerSendCommands(program: Command): void {
  const sendTo = cliArgument(SEND_CLI, "to")
  const sendMessage = cliArgument(SEND_CLI, "message")
  const sendType = cliOption(SEND_CLI, "type")
  const sendSummary = cliOption(SEND_CLI, "summary")
  const sendMessageId = cliOption(SEND_CLI, "message-id")
  const sendDelivery = cliOption(SEND_CLI, "delivery")
  const sendRef = cliOption(SEND_CLI, "ref")
  const sendReply = cliOption(SEND_CLI, "reply")
  const sendAnonymous = cliOption(SEND_CLI, "anonymous")
  const sendRequest = cliOption(SEND_CLI, "request")
  const sendFanout = cliOption(SEND_CLI, "fanout")
  const sendExpiresInMs = cliOption(SEND_CLI, "expires-in-ms")
  const sendIncident = cliOption(SEND_CLI, "incident")
  const sendIncidentCleared = cliOption(SEND_CLI, "incident-cleared")
  program
    .command(SEND_CLI.name)
    .description(SEND_CLI.description)
    .argument(`<${sendTo.name}>`, sendTo.description)
    .argument(`<${sendMessage.name}...>`, sendMessage.description)
    .option(sendType.flags, sendType.description)
    .option(sendSummary.flags, sendSummary.description)
    .option(sendMessageId.flags, sendMessageId.description)
    .option(sendDelivery.flags, sendDelivery.description)
    .option(sendRef.flags, sendRef.description)
    .option(sendReply.flags, sendReply.description)
    .option(sendAnonymous.flags, sendAnonymous.description)
    .option(sendRequest.flags, sendRequest.description)
    .option(sendFanout.flags, sendFanout.description)
    .option(sendExpiresInMs.flags, sendExpiresInMs.description)
    .option(sendIncident.flags, sendIncident.description)
    .option(sendIncidentCleared.flags, sendIncidentCleared.description)
    .action(
      (
        to: string,
        message: string[],
        opts: {
          type?: string
          summary?: string
          messageId?: string
          delivery?: string
          ref?: string
          request?: boolean | string
          reply?: string
          anonymous?: boolean
          fanout?: string
          expiresInMs?: string
          incident?: string
          incidentCleared?: boolean
        },
      ) => {
        const type = opts.type ?? "notify"
        if (!(TRIBE_MESSAGE_TYPES as readonly string[]).includes(type)) {
          console.error(
            `tribe-wire send: invalid --type '${type}' — expected one of: ${TRIBE_MESSAGE_TYPES.join(", ")}`,
          )
          process.exit(2)
        }
        // A SECOND RECIPIENT MUST NEVER BECOME MESSAGE TEXT.
        //
        // `send` is `<to>` plus a variadic `<message...>`, so `tribe send @a @b
        // "text"` made `@b` the first WORD OF THE BODY, delivered to `@a`
        // alone, printed "Sent message to @a" and exited 0. The dropped
        // recipient was indistinguishable from success — the exact shape the
        // NO SILENT ERRORS rule exists to stop.
        //
        // The discriminator is deliberately narrow: a BARE seat token as the
        // first word AND a body the shell split into several arguments. Normal
        // correct usage quotes the message into one argument, so prose that
        // legitimately opens with "@chief ..." does not trip this.
        //
        // This refuses rather than accepting a recipient list: the daemon and
        // the MCP surface do take `to` as an array with `fanout`, but widening
        // `<to>` here is a public API change. Failing loud is the bug fix.
        const swallowedRecipient = message.length > 1 ? (message[0] ?? "") : ""
        if (/^@[A-Za-z0-9_/-]+$/u.test(swallowedRecipient)) {
          console.error(
            `tribe-wire send: refusing — '${swallowedRecipient}' looks like a second recipient, but this command ` +
              `takes exactly one. It would have been absorbed into the message body and delivered to '${to}' alone, ` +
              `with '${swallowedRecipient}' silently receiving nothing.`,
          )
          console.error(`Send to each recipient separately:`)
          console.error(`  tribe send ${to} "<message>"`)
          console.error(`  tribe send ${swallowedRecipient} "<message>"`)
          console.error(`Or broadcast with: tribe send '*' "<message>"`)
          console.error(
            `If '${swallowedRecipient}' really is the first word of your message, quote the whole message as one argument.`,
          )
          process.exit(2)
        }
        if (opts.delivery !== undefined && !(TRIBE_DELIVERY_MODES as readonly string[]).includes(opts.delivery)) {
          console.error(
            `tribe-wire send: invalid --delivery '${opts.delivery}' — expected one of: ${TRIBE_DELIVERY_MODES.join(", ")}`,
          )
          process.exit(2)
        }
        if (opts.fanout !== undefined && !(TRIBE_FANOUTS as readonly string[]).includes(opts.fanout)) {
          console.error(
            `tribe-wire send: invalid --fanout '${opts.fanout}' — expected one of: ${TRIBE_FANOUTS.join(", ")}`,
          )
          process.exit(2)
        }
        const expiresInMs = opts.expiresInMs === undefined ? undefined : Number(opts.expiresInMs)
        if (expiresInMs !== undefined && !Number.isSafeInteger(expiresInMs)) {
          console.error(`tribe-wire send: invalid --expires-in-ms '${opts.expiresInMs}' — expected an integer`)
          process.exit(2)
        }
        // Validated here as well as in buildSendPayload so a malformed key
        // exits 2 with the shape named, rather than surfacing as a stack trace.
        if (opts.incident !== undefined && parseIncidentKey(opts.incident) === null) {
          console.error(
            `tribe-wire send: invalid --incident '${opts.incident}' — expected emitter${INCIDENT_KEY_SEPARATOR}subject${INCIDENT_KEY_SEPARATOR}condition with all three parts non-empty`,
          )
          process.exit(2)
        }
        if (opts.incidentCleared === true && opts.incident === undefined) {
          console.error(
            "tribe-wire send: --incident-cleared requires --incident <emitter:subject:condition> naming the condition that cleared",
          )
          process.exit(2)
        }
        void cmdSend({
          to,
          message: message.join(" "),
          type: type as MessageType,
          summary: opts.summary,
          messageId: opts.messageId,
          delivery: opts.delivery as Delivery | undefined,
          ref: opts.ref,
          request: opts.request === "true" ? true : opts.request === false ? undefined : opts.request,
          reply: opts.reply,
          anonymous: opts.anonymous,
          fanout: opts.fanout as Fanout | undefined,
          expiresInMs,
          incident: opts.incident,
          incidentCleared: opts.incidentCleared,
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
