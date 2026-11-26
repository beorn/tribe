/**
 * The one root sender of tribe incidents (@cto 979f218d, 25092 S3c): a standing ball keyed
 * `emitter:subject:condition`. Tribe keeps one ball per key, so a repeat upserts it, and only its emitter clears it.
 * tools/state-project-watch.ts, tools/state-checkout-sync.ts, tools/onfail.ts, guard 2 (tools/verify-full-suite.ts
 * post-merge) and tent's dark-work all send through here; the key comes from tribe-wire's own builder.
 *
 * It sends through tribe-wire's one sender (25074 3d-1c, @cto 082a4259): a hab service registers as itself on its
 * token, a seat-run emitter registers as the seat with the emitter named in the ball's key, and a process with no token
 * is refused before anything is sent. A send never fails silently: the result carries the outcome, a daemon's refusal
 * included, and every caller says what it does with a failure.
 */
import { createHash, randomUUID } from "node:crypto"
import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  CLIENT_MESSAGE_MAX_LENGTH,
  incidentKey,
  mcpJsonContent,
  parseEmitterIncidentSnapshot,
  type EmitterIncidentSnapshot,
  type IncidentIdentity,
} from "../barrels/records.ts"
import { atomicWriteFileSync } from "@bearly/durable-file"
import { connectToDaemon, type DaemonClient } from "../barrels/client.ts"
import { resolveSocketPath } from "./socket.ts"
import {
  describeDaemonOutcome,
  launchSender,
  registerLaunchSender,
  tribeDaemonCalls,
  type SendOutcome,
} from "../service-send.ts"

/**
 * How long one send may take. A caller that sends while holding a lock (guard 2 holds its run lock) would otherwise
 * hang on a stuck daemon, and every later tick would read as "a run holds the lock" instead of failing loud.
 */
export const TRIBE_INCIDENT_SEND_TIMEOUT_MS = 60_000

/**
 * How many times ONE held session may rebuild its client after a dead call (29022). A daemon restart is worth a
 * rebuild; a wire that dies on every call is not, and rebuilding per call turned a rebind into an endless reconnect
 * whose sends kept landing while the authoritative read never confirmed them. Past the budget every call returns the
 * dead outcome, so the caller's own bound names the failure and releases its lock instead of rebuilding forever.
 */
export const TRIBE_INCIDENT_MAX_RECONNECTS = 5

export type TribeIncidentSend = Readonly<{
  to: string
  identity: IncidentIdentity
  /** The clearing edge: the condition ended, and the ball closes. */
  cleared: boolean
  summary: string
  body: string
  incidentData?: unknown
  ifCurrent?: readonly Readonly<{ recipient: string; message_id: string }>[]
}>

/** Shared transport input; incident callers supply tracking, plain notifies supply none. */
export type TribeMessageSend = Readonly<
  {
    to: string
    emitter: string
    key: string
    summary: string
    body: string
  } & (
    | {
        type: "request"
        incident: IncidentIdentity & { active?: boolean }
        incidentData?: unknown
        ifCurrent?: readonly Readonly<{ recipient: string; message_id: string }>[]
      }
    | { type: "notify"; incident?: never }
  )
>

/**
 * What the daemon answered for this incident's key. `overflow`: the body was over the wire's cap, so the send carried
 * a cut ending in a pointer, and this file keeps the full text (25605).
 */
export type TribeIncidentSendResult = Readonly<{
  key: string
  outcome: SendOutcome
  overflow?: string
  conflict?: unknown
  /** Client-generated id minted before the first send; reused on a reconnect retry. */
  message_id?: string
}>

/** Held authenticated RPCs on one connection; {@link withTribeIncidentSession} supplies this. */
export type TribeIncidentTransport = Readonly<{
  sendAs: (params: Readonly<Record<string, unknown>>, timeoutMs: number) => Promise<SendOutcome>
  pendingForEmitter: (emitter: string, timeoutMs: number) => Promise<SendOutcome>
}>

export type TribeIncidentSendOptions = Readonly<{
  /** Where the sender's identity token is read (HAB_ID_TOKEN); the process environment by default. */
  env?: NodeJS.ProcessEnv
  /** The daemon socket; the resolved default when omitted. */
  socketPath?: string
  /** Defaults to {@link TRIBE_INCIDENT_SEND_TIMEOUT_MS}; past it the send is abandoned and the result says so. */
  timeoutMs?: number
  /** Where a body over the wire's cap keeps its full text; defaults to {@link defaultIncidentOverflowDir}. */
  overflowDir?: string
  /**
   * Held authenticated transport. When set, send/read reuse it instead of connect+register per RPC
   * (#28294; one joined row and one left row per run).
   */
  transport?: TribeIncidentTransport
  /** How many times a HELD session may rebuild its client after a dead call; defaults to
   * {@link TRIBE_INCIDENT_MAX_RECONNECTS}. Ignored by the one-shot path. */
  maxReconnects?: number
}>

export type TribeIncidentSession = Readonly<{
  sendIncident: typeof sendTribeIncident
  sendMessage: typeof sendTribeMessage
  readIncidents: typeof readTribeIncidents
  socketPath: string
  /**
   * `tribe.pending` as the registered producer (an owner's pile, or a sender-withdrawn `close`). Only the held
   * {@link withTribeIncidentSession} offers it; the page-incident migration (#37340) withdraws hab's legacy page balls.
   */
  pending?: (params: Readonly<Record<string, unknown>>) => Promise<SendOutcome>
  /**
   * `tribe.fetch` as the registered producer: a read of rows a caller already knows by id (their settlement verdict
   * included), never a cursor move. Only the held {@link withTribeIncidentSession} offers it; workmon's retro poll
   * reads the poll's own request ids through it so an answer arriving after the Keeper's capture still clears (#37323).
   */
  fetch?: (params: Readonly<Record<string, unknown>>) => Promise<SendOutcome>
  /** Connect/register already failed; bound read/send name this without a new RPC. */
  openFailure?: SendOutcome
}>

/**
 * Where an over-cap body keeps its full text unless the caller names a directory: the host's per-user state
 * (`$XDG_STATE_HOME`, else ~/.local/state) under tribe/incident-bodies, readable by every seat of this user.
 */
export function defaultIncidentOverflowDir(env: NodeJS.ProcessEnv = process.env): string {
  const state =
    env.XDG_STATE_HOME !== undefined && env.XDG_STATE_HOME !== ""
      ? env.XDG_STATE_HOME
      : join(homedir(), ".local", "state")
  return join(state, "tribe", "incident-bodies")
}

/**
 * The body the wire accepts (25605): unchanged at or under CLIENT_MESSAGE_MAX_LENGTH, else its full text written to
 * a file in `dir` and the body cut to fit, ending in a line that says it was cut and names the file. The wire refuses
 * an over-cap message whole, so without this an incident over the cap reached nobody. Throws when the file cannot be
 * written: a pointer to text that was not kept is not sent.
 *
 * One file per incident key, replaced on each send (25950): a flapping red resends its key, and a stamped file per
 * send grew the store without bound. The ball holds one live body per key, so its file does too; the trailer's sha256
 * says which text an older message pointed at. The name keeps a hash of the raw key, so two keys that read the same
 * once sanitized never share a file.
 */
export function fitTribeMessage(key: string, body: string, dir: string): { body: string; overflow?: string } {
  if (body.length <= CLIENT_MESSAGE_MAX_LENGTH) return { body }
  const sha256 = createHash("sha256").update(body, "utf8").digest("hex")
  const keyHash = createHash("sha256").update(key, "utf8").digest("hex").slice(0, 12)
  const path = join(dir, `${key.replace(/[^\w.-]+/gu, "_")}-${keyHash}.txt`)
  mkdirSync(dir, { recursive: true })
  // Written aside and renamed over, so a reader never sees half of one body and half of the next.
  atomicWriteFileSync(path, body, 0o666)
  const trailer =
    `\n\n[cut to fit the ${String(CLIENT_MESSAGE_MAX_LENGTH)}-character message cap: ` +
    `${String(body.length)} characters in full, sha256 ${sha256}, kept at ${path}]`
  let head = body.slice(0, CLIENT_MESSAGE_MAX_LENGTH - trailer.length)
  // Never end on half of a surrogate pair.
  if (/[\uD800-\uDBFF]$/u.test(head)) head = head.slice(0, -1)
  return { body: `${head}${trailer}`, overflow: path }
}

type HeldErrorOutcome = Readonly<{ kind: "error"; message: string; code?: string }>
type HeldOutcome = Exclude<SendOutcome, { kind: "error" }> | HeldErrorOutcome

function outcomeFromThrown(error: unknown): HeldOutcome {
  const code = (error as NodeJS.ErrnoException).code
  if (code === "ECONNREFUSED" || code === "ENOENT") return { kind: "no-daemon" }
  // A timeout keeps how long it waited and what it was reading; describeDaemonOutcome writes the sentence (33937).
  if (code === "TRIBE_DAEMON_CALL_TIMEOUT") {
    const timedOut = error as { method: string; timeoutMs: number }
    return { kind: "timeout", afterMs: timedOut.timeoutMs, reading: timedOut.method }
  }
  if (code === "TRIBE_DAEMON_CONNECT_TIMEOUT") {
    return { kind: "timeout", afterMs: (error as { timeoutMs: number }).timeoutMs, reading: "the socket (connect)" }
  }
  const message = error instanceof Error ? error.message : String(error)
  return typeof code === "string" && code.length > 0 ? { kind: "error", message, code } : { kind: "error", message }
}

/** Pin 1 (@cto 76d7dc00): retry only these dead-transport failures, never timeout or refusal. */
function isDeadHeldOutcome(outcome: HeldOutcome): boolean {
  if (outcome.kind === "no-daemon") return true
  if (outcome.kind !== "error") return false
  if (outcome.code === "TRIBE_DAEMON_CALL_TIMEOUT" || outcome.code === "TRIBE_DAEMON_CONNECT_TIMEOUT") {
    return false
  }
  if (
    outcome.code === "ECONNRESET" ||
    outcome.code === "EPIPE" ||
    outcome.code === "ENOENT" ||
    outcome.code === "ECONNREFUSED"
  ) {
    return true
  }
  return outcome.message === "Connection closed"
}

function holdingsKey(row: Readonly<{ recipient: string; message_id: string }>): string {
  return `${row.recipient}\0${row.message_id}`
}

function holdingsEqual(
  actual: readonly Readonly<{ recipient: string; message_id: string }>[],
  intended: readonly Readonly<{ recipient: string; message_id: string }>[],
): boolean {
  if (actual.length !== intended.length) return false
  const keys = new Set(actual.map(holdingsKey))
  return intended.every((row) => keys.has(holdingsKey(row)))
}

async function callHeld(
  client: DaemonClient,
  method: string,
  params: Readonly<Record<string, unknown>>,
  timeoutMs: number,
): Promise<HeldOutcome> {
  try {
    const value = await client.call(method, params, { timeoutMs })
    const refusal = (mcpJsonContent(value) as { readonly error?: unknown } | null)?.error
    return typeof refusal === "string" && refusal.length > 0 ? { kind: "refused", refusal } : { kind: "ok", value }
  } catch (error) {
    return outcomeFromThrown(error)
  }
}

function oneShotCalls(emitter: string, options: TribeIncidentSendOptions): ReturnType<typeof tribeDaemonCalls> {
  return tribeDaemonCalls(emitter, {
    env: options.env,
    ...(options.socketPath === undefined ? {} : { socketPath: options.socketPath }),
    deadlineMs: options.timeoutMs ?? TRIBE_INCIDENT_SEND_TIMEOUT_MS,
  })
}

/**
 * Hold ONE daemon client for the duration of `fn`: connect once, registerLaunchSender once, route every
 * read and send through it, close once (#28294, @cto 9edd6c72). One-shot send/read stay available for
 * callers that make a single RPC. A connect or register failure is returned through the bound send/read
 * in the same shapes as the one-shot path (send outcome, read throw); `fn` still runs.
 */
export async function withTribeIncidentSession<T>(
  producer: string,
  options: TribeIncidentSendOptions,
  fn: (session: TribeIncidentSession) => Promise<T>,
): Promise<T> {
  const socketPath = options.socketPath ?? resolveSocketPath()
  const timeoutMs = options.timeoutMs ?? TRIBE_INCIDENT_SEND_TIMEOUT_MS
  let client: DaemonClient | undefined
  let transport: TribeIncidentTransport | undefined
  let openFailure: SendOutcome | undefined
  const reconnectState = { lastCallReconnected: false, reconnects: 0 }
  const maxReconnects = options.maxReconnects ?? TRIBE_INCIDENT_MAX_RECONNECTS
  const registerHeld = async (held: DaemonClient, openTimeoutMs: number): Promise<void> => {
    const sender = launchSender(producer, options.env ?? process.env)
    let registerTimer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        registerLaunchSender(held, sender, { producer, socketPath }),
        new Promise<never>((_resolve, reject) => {
          registerTimer = setTimeout(() => {
            const error = new Error(
              `could not register ${producer} at ${socketPath} within ${String(openTimeoutMs)}ms`,
            ) as NodeJS.ErrnoException
            error.code = "TRIBE_DAEMON_CALL_TIMEOUT"
            reject(error)
          }, openTimeoutMs)
        }),
      ])
    } finally {
      if (registerTimer !== undefined) clearTimeout(registerTimer)
    }
  }
  const callWithReconnect = async (
    method: string,
    params: Readonly<Record<string, unknown>>,
    callTimeoutMs: number,
  ): Promise<HeldOutcome> => {
    const held = client
    if (held === undefined) return { kind: "error", message: "held transport missing after open" }
    reconnectState.lastCallReconnected = false
    const first = await callHeld(held, method, params, callTimeoutMs)
    if (!isDeadHeldOutcome(first)) return first
    if (reconnectState.reconnects >= maxReconnects) {
      return {
        kind: "error",
        message: `held transport died and its rebuild budget is spent after ${String(maxReconnects)} rebuild(s): ${describeDaemonOutcome(first)}`,
      }
    }
    reconnectState.reconnects += 1
    reconnectState.lastCallReconnected = true
    held.close()
    try {
      // ZERO connect-retry window, on purpose (@cto 29022 Q2): this rebuild sits UNDER the session's own rebuild
      // budget (reconnectState/maxReconnects), so it is the outer retry owner the transport's connectWithRetry
      // contract names, and the inner 28674 restart wait must not stack under it — two layers would make one budget
      // spend up to maxReconnects × 6 s before the caller's bound could name the failure. An absent/refused socket
      // here fails loud at once, the outcome the held-session tests already pin; a dropped connection whose socket
      // is still present reconnects either way. The one-shot OPEN below keeps the 28674 window: it has no outer
      // owner.
      client = await connectToDaemon(socketPath, { callTimeoutMs, connectRetryWindowMs: 0 })
      await registerHeld(client, callTimeoutMs)
    } catch (error) {
      client?.close()
      client = undefined
      const retryOpen = outcomeFromThrown(error)
      return {
        kind: "error",
        message: `held transport died again on retry: ${describeDaemonOutcome(retryOpen)}`,
      }
    }
    const retry = await callHeld(client, method, params, callTimeoutMs)
    if (isDeadHeldOutcome(retry)) {
      return {
        kind: "error",
        message: `held transport died again on retry: ${describeDaemonOutcome(retry)}`,
      }
    }
    return retry
  }
  try {
    try {
      client = await connectToDaemon(socketPath, { callTimeoutMs: timeoutMs })
      await registerHeld(client, timeoutMs)
      transport = {
        sendAs: (params, callTimeoutMs) => callWithReconnect("tribe.send", params, callTimeoutMs),
        pendingForEmitter: (emitter, callTimeoutMs) => callWithReconnect("tribe.pending", { emitter }, callTimeoutMs),
      }
    } catch (error) {
      client?.close()
      client = undefined
      openFailure = outcomeFromThrown(error)
    }
    if (openFailure === undefined && transport === undefined) {
      throw new Error("withTribeIncidentSession: open reported success without a held transport")
    }
    const held = transport
    const settleConflictIfRetryApplied = async (
      send: TribeIncidentSend,
      result: TribeIncidentSendResult,
      extra: TribeIncidentSendOptions | undefined,
    ): Promise<TribeIncidentSendResult> => {
      if (
        !reconnectState.lastCallReconnected ||
        result.outcome.kind !== "refused" ||
        result.conflict === undefined ||
        held === undefined
      ) {
        return result
      }
      const snapshot = await readTribeIncidents(send.identity.emitter, { ...options, ...extra, transport: held })
      const actual = snapshot.pending
        .filter(
          (row) =>
            row.identity.emitter === send.identity.emitter &&
            row.identity.subject === send.identity.subject &&
            row.identity.condition === send.identity.condition,
        )
        .map((row) => ({ recipient: row.recipient, message_id: row.message_id }))
      const intended = send.cleared
        ? []
        : result.message_id === undefined
          ? undefined
          : [{ recipient: send.to, message_id: result.message_id }]
      if (intended === undefined) return result
      return holdingsEqual(actual, intended)
        ? { key: result.key, outcome: { kind: "ok", value: snapshot }, message_id: result.message_id }
        : result
    }
    const session: TribeIncidentSession = {
      socketPath,
      ...(openFailure === undefined ? {} : { openFailure }),
      pending: (params) =>
        openFailure !== undefined || held === undefined
          ? Promise.resolve(openFailure ?? { kind: "error", message: "held transport missing after open" })
          : callWithReconnect("tribe.pending", params, timeoutMs),
      fetch: (params) =>
        openFailure !== undefined || held === undefined
          ? Promise.resolve(openFailure ?? { kind: "error", message: "held transport missing after open" })
          : callWithReconnect("tribe.fetch", params, timeoutMs),
      sendIncident: async (send, extra) => {
        if (openFailure !== undefined || held === undefined) {
          return {
            key: incidentKey(send.identity),
            outcome: openFailure ?? { kind: "error", message: "held transport missing after open" },
          }
        }
        const result = await sendTribeIncident(send, { ...options, ...extra, transport: held })
        return settleConflictIfRetryApplied(send, result, extra)
      },
      sendMessage: (send, extra) => {
        if (openFailure !== undefined || held === undefined) {
          return Promise.resolve({
            key: send.key,
            outcome: openFailure ?? { kind: "error", message: "held transport missing after open" },
          })
        }
        return sendTribeMessage(send, { ...options, ...extra, transport: held })
      },
      readIncidents: (emitter, extra) => {
        if (openFailure !== undefined || held === undefined) {
          return Promise.reject(
            new Error(
              `could not read incidents for ${emitter} at ${socketPath}: ${describeDaemonOutcome(openFailure ?? { kind: "error", message: "held transport missing after open" })}`,
            ),
          )
        }
        return readTribeIncidents(emitter, { ...options, ...extra, transport: held })
      },
    }
    return await fn(session)
  } finally {
    client?.close()
  }
}

/**
 * One connection, never registered (#28294, @cto 865c143a): HAB_ID_TOKEN rides on each
 * tribe.send / tribe.pending {emitter} RPC. The socket stays pending-*, so close journals
 * no joined/left rows. Used by longproc-reading --notify; other emitters keep
 * {@link withTribeIncidentSession}.
 */
export async function withPendingTribeTokenSession<T>(
  producer: string,
  options: TribeIncidentSendOptions,
  fn: (session: TribeIncidentSession) => Promise<T>,
): Promise<T> {
  const socketPath = options.socketPath ?? resolveSocketPath()
  const timeoutMs = options.timeoutMs ?? TRIBE_INCIDENT_SEND_TIMEOUT_MS
  let client: DaemonClient | undefined
  let transport: TribeIncidentTransport | undefined
  let openFailure: SendOutcome | undefined
  try {
    try {
      const sender = launchSender(producer, options.env ?? process.env)
      client = await connectToDaemon(socketPath, { callTimeoutMs: timeoutMs })
      const held = client
      const idToken = sender.idToken
      transport = {
        sendAs: (params, callTimeoutMs) => callHeld(held, "tribe.send", { ...params, idToken }, callTimeoutMs),
        pendingForEmitter: (emitter, callTimeoutMs) =>
          callHeld(held, "tribe.pending", { emitter, idToken }, callTimeoutMs),
      }
    } catch (error) {
      client?.close()
      client = undefined
      openFailure = outcomeFromThrown(error)
    }
    if (openFailure === undefined && transport === undefined) {
      throw new Error("withPendingTribeTokenSession: open reported success without a held transport")
    }
    const held = transport
    const session: TribeIncidentSession = {
      socketPath,
      ...(openFailure === undefined ? {} : { openFailure }),
      sendIncident: (send, extra) => {
        if (openFailure !== undefined || held === undefined) {
          return Promise.resolve({
            key: incidentKey(send.identity),
            outcome: openFailure ?? { kind: "error", message: "held transport missing after open" },
          })
        }
        return sendTribeIncident(send, { ...options, ...extra, transport: held })
      },
      sendMessage: (send, extra) => {
        if (openFailure !== undefined || held === undefined) {
          return Promise.resolve({
            key: send.key,
            outcome: openFailure ?? { kind: "error", message: "held transport missing after open" },
          })
        }
        return sendTribeMessage(send, { ...options, ...extra, transport: held })
      },
      readIncidents: (emitter, extra) => {
        if (openFailure !== undefined || held === undefined) {
          return Promise.reject(
            new Error(
              `could not read incidents for ${emitter} at ${socketPath}: ${describeDaemonOutcome(openFailure ?? { kind: "error", message: "held transport missing after open" })}`,
            ),
          )
        }
        return readTribeIncidents(emitter, { ...options, ...extra, transport: held })
      },
    }
    return await fn(session)
  } finally {
    client?.close()
  }
}

/** Send one incident edge through the shared transport; the incident API remains unchanged. */
export async function sendTribeIncident(
  send: TribeIncidentSend,
  options: TribeIncidentSendOptions = {},
): Promise<TribeIncidentSendResult> {
  return sendTribeMessage(
    {
      to: send.to,
      emitter: send.identity.emitter,
      key: incidentKey(send.identity),
      type: "request",
      summary: send.summary,
      body: send.body,
      incident: send.cleared ? { ...send.identity, active: false } : send.identity,
      ...(send.incidentData === undefined ? {} : { incidentData: send.incidentData }),
      ...(send.ifCurrent === undefined ? {} : { ifCurrent: send.ifCurrent }),
    },
    options,
  )
}

/** The one transport for incidents and plain notifies; callers report its returned failures. */
export async function sendTribeMessage(
  send: TribeMessageSend,
  options: TribeIncidentSendOptions = {},
): Promise<TribeIncidentSendResult> {
  const key = send.key
  const dir = options.overflowDir ?? defaultIncidentOverflowDir(options.env ?? process.env)
  let fitted: { body: string; overflow?: string }
  try {
    fitted = fitTribeMessage(key, send.body, dir)
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error)
    return {
      key,
      outcome: {
        kind: "error",
        message: `could not keep the full body (${String(send.body.length)} characters) under ${dir}, so nothing was sent: ${why}`,
      },
    }
  }
  const timeoutMs = options.timeoutMs ?? TRIBE_INCIDENT_SEND_TIMEOUT_MS
  const held = options.transport
  const sendAs =
    held === undefined
      ? oneShotCalls(send.emitter, options).sendAs
      : (params: Readonly<Record<string, unknown>>) => held.sendAs(params, timeoutMs)
  const messageId = randomUUID()
  let outcome = await sendAs({
    to: send.to,
    message: fitted.body,
    type: send.type,
    summary: send.summary,
    message_id: messageId,
    ...(send.type === "request"
      ? {
          incident: send.incident,
          ...(send.incidentData === undefined ? {} : { incident_data: send.incidentData }),
          ...(send.ifCurrent === undefined ? {} : { if_current: send.ifCurrent }),
        }
      : {}),
  })
  const payload =
    outcome.kind === "ok" ? (mcpJsonContent(outcome.value) as { sent?: unknown; conflict?: unknown } | null) : null
  const conflict = payload?.sent === false ? payload.conflict : undefined
  if (payload?.sent === false) {
    outcome = {
      kind: "refused",
      refusal:
        conflict === undefined
          ? "daemon did not accept the incident send"
          : "incident current holdings changed; re-read before retrying",
    }
  }
  return {
    key,
    outcome,
    message_id: messageId,
    ...(fitted.overflow === undefined ? {} : { overflow: fitted.overflow }),
    ...(conflict === undefined ? {} : { conflict }),
  }
}

/**
 * The read waited its whole allowance and the daemon did not answer.
 *
 * Inconclusive, not wrong: a caller that can read again next pass should record the skip, while a caller that cannot
 * should fail loudly. Typed so the decision is made on the outcome, never by matching the sentence (#37601).
 */
export class TribeIncidentReadTimeoutError extends Error {
  readonly emitter: string
  readonly socketPath: string
  readonly afterMs: number
  readonly reading: string
  constructor(input: { emitter: string; socketPath: string; afterMs: number; reading: string }) {
    super(
      `could not read incidents for ${input.emitter} at ${input.socketPath}: ` +
        `timed out after ${String(input.afterMs / 1000)} s reading ${input.reading}`,
    )
    this.name = "TribeIncidentReadTimeoutError"
    this.emitter = input.emitter
    this.socketPath = input.socketPath
    this.afterMs = input.afterMs
    this.reading = input.reading
  }
}

/** Authenticated complete read; failure never means an empty condition set. */
export async function readTribeIncidents(
  emitter: string,
  options: TribeIncidentSendOptions = {},
): Promise<EmitterIncidentSnapshot> {
  const socketPath = options.socketPath ?? resolveSocketPath()
  const timeoutMs = options.timeoutMs ?? TRIBE_INCIDENT_SEND_TIMEOUT_MS
  const held = options.transport
  const pendingForEmitter =
    held === undefined
      ? oneShotCalls(emitter, options).pendingForEmitter
      : (name: string) => held.pendingForEmitter(name, timeoutMs)
  const outcome = await pendingForEmitter(emitter)
  if (outcome.kind === "timeout") {
    throw new TribeIncidentReadTimeoutError({
      emitter,
      socketPath,
      afterMs: outcome.afterMs,
      reading: outcome.reading,
    })
  }
  if (outcome.kind !== "ok") {
    throw new Error(`could not read incidents for ${emitter} at ${socketPath}: ${describeDaemonOutcome(outcome)}`)
  }
  try {
    return parseEmitterIncidentSnapshot(mcpJsonContent(outcome.value), emitter)
  } catch (error) {
    throw new Error(`could not read incidents for ${emitter} at ${socketPath}: invalid emitter snapshot`, {
      cause: error,
    })
  }
}

/** One line naming a failed send, or undefined when it was delivered. */
export function tribeIncidentSendFailure(result: TribeIncidentSendResult): string | undefined {
  if (result.outcome.kind === "ok") return undefined
  return `could not send incident ${result.key}: ${describeDaemonOutcome(result.outcome)}`
}
