/**
 * The ONE sender for every producer that is not a seat's own conversation (25074 3d-1c, @cto 082a4259): `hab
 * attention`, `hab page project`, `ag quota wall`, the root incident emitters, telegram, coordination-watch and
 * yrd-notify. A pile read needs no identity. A send registers as what its launch's identity token names, so every
 * producer has one answer to "who am I on the wire" (25689 moved the client here from hab-cli so both CLIs share it).
 */
import { connectTribeLaunch } from "./launch-registration.ts"
import { oneShotRegisterParams, resolveLaunchSeat } from "./launch-seat.ts"
import { mcpJsonContent } from "./cli/mcp-json-content.ts"
import { HAB_ID_TOKEN_ENV, readIdentityTokenFromEnvironment, readUnverifiedTokenClaims } from "./lib/identity-token.ts"
import { resolveSocketPath } from "./paths.ts"
import { withDaemonCall, type DaemonCallOutcome } from "./util.ts"
import type { DaemonClient } from "./client.ts"

/** Whole connect+call budget per daemon operation; tribe.health took ~5s under load. */
export const TRIBE_DAEMON_DEADLINE_MS = 10_000

export interface TribeDaemonCalls {
  /** `tribe.pending {owner}` — the open balls `owner` must answer; needs no identity. */
  pendingFor(owner: string): Promise<DaemonCallOutcome<unknown>>
  /** `tribe.members {all: true}` — every session row the daemon has, disconnected included; needs no identity. */
  members(): Promise<DaemonCallOutcome<unknown>>
  /** Register as this launch's token names (see {@link launchSender}), then `tribe.send` with these params VERBATIM. */
  sendAs(params: Readonly<Record<string, unknown>>): Promise<SendOutcome>
}

/**
 * A send's outcome. `refused` is the daemon answering and declining the send in-band (its result carries `error`),
 * carried as data so a caller tells it from a transport failure by kind (@cto 26ff1f69 rider 1): nothing was delivered.
 */
export type SendOutcome = DaemonCallOutcome<unknown> | Readonly<{ kind: "refused"; refusal: string }>

export function tribeDaemonCalls(
  producer: string,
  opts: {
    socketPath?: string
    deadlineMs?: number
    /** Where the launch's identity token is read (HAB_ID_TOKEN); the process environment by default. */
    env?: Readonly<NodeJS.ProcessEnv>
  } = {},
): TribeDaemonCalls {
  const socketPath = opts.socketPath ?? resolveSocketPath()
  const deadlineMs = opts.deadlineMs ?? TRIBE_DAEMON_DEADLINE_MS
  return {
    pendingFor: (owner) =>
      withDaemonCall({ socketPath, deadlineMs }, (client) => client.call("tribe.pending", { owner })),
    members: () => withDaemonCall({ socketPath, deadlineMs }, (client) => client.call("tribe.members", { all: true })),
    sendAs: async (params) => {
      let sender: LaunchSender
      try {
        sender = launchSender(producer, opts.env ?? process.env)
      } catch (error) {
        // Refused before the daemon: nothing registers and nothing is sent.
        return { kind: "error", message: error instanceof Error ? error.message : String(error) }
      }
      const outcome = await withDaemonCall({ socketPath, deadlineMs, callTimeoutMs: deadlineMs }, async (client) => {
        await registerLaunchSender(client, sender, { producer, socketPath })
        return client.call("tribe.send", params)
      })
      if (outcome.kind !== "ok") return outcome
      // The daemon refuses a send in-band, as a result whose content carries `error`; that is no delivery.
      const refusal = (mcpJsonContent(outcome.value) as { readonly error?: unknown } | null)?.error
      return typeof refusal === "string" && refusal.length > 0 ? { kind: "refused", refusal } : outcome
    },
  }
}

/**
 * Who a launch's sends register as (25074 3d-1c, @cto 082a4259): the one answer to "who am I on the wire" for every
 * producer that is not a seat's own conversation. The producer itself rides in the message (an incident's emitter, a
 * page's line).
 */
export type LaunchSender =
  | Readonly<{ kind: "service"; name: string; idToken: string }>
  | Readonly<{ kind: "seat"; name: string; launchId: string }>

/**
 * Who `producer` sends as. A hab service's token (act.kind "service") registers as that service, on its token; a
 * seat's token registers as the seat, fanning into its live session through the launch the token's sid names; no
 * token is refused, naming the producer and the cure. The claims are read unverified, for their shape only: the
 * daemon verifies the token. Throws on a missing or malformed token.
 */
export function launchSender(producer: string, env: Readonly<NodeJS.ProcessEnv>): LaunchSender {
  const idToken = readIdentityTokenFromEnvironment(env)
  if (idToken === null) {
    throw new Error(
      `${producer}: no identity token (${HAB_ID_TOKEN_ENV}) to send as; run it from a hab seat, or as the hab ` +
        "service whose token names it",
    )
  }
  let claims: ReturnType<typeof readUnverifiedTokenClaims>
  try {
    claims = readUnverifiedTokenClaims(idToken)
  } catch (error) {
    throw new Error(`${producer}: ${error instanceof Error ? error.message : String(error)}`)
  }
  return claims.kind === "service"
    ? { kind: "service", name: claims.actor, idToken }
    : { kind: "seat", name: claims.actor, launchId: claims.sid }
}

/**
 * Register `client` as `sender`; the name the daemon granted. A service registers its own launch on its token; a seat
 * registers under the daemon's own launch tuple, so the connection joins the live seat without takeover. A caller
 * that sends several messages on one connection (yrd-notify) registers it here once.
 */
export async function registerLaunchSender(
  client: DaemonClient,
  sender: LaunchSender,
  context: Readonly<{ producer: string; socketPath: string }>,
): Promise<string> {
  if (sender.kind === "service") {
    // connectTribeLaunch refuses any grant but the name it asked for.
    await connectTribeLaunch(
      {
        name: sender.name,
        idToken: sender.idToken,
        principalClass: "service",
        cwd: process.cwd(),
        domains: ["service"],
        takeover: false,
      },
      {
        connect: () => Promise.resolve(client),
        socketPath: () => context.socketPath,
        sleep: (ms) =>
          new Promise((resolve) => {
            setTimeout(resolve, ms)
          }),
        processId: () => process.pid,
      },
    )
    // connectTribeLaunch unrefs the socket it registers, which is right for a long-running service connection. This one
    // is the caller's one-shot: re-ref it, so that its close completes before the process exits. An unref'd socket
    // let a notifier exit mid-close, and the daemon warned "managed bridge lost after socket error" on every send
    // (review of d411211143).
    client.socket.ref()
    return sender.name
  }
  const seat = await resolveLaunchSeat((method, params) => client.call(method, params), {
    launchId: sender.launchId,
    persona: sender.name,
  })
  const registered = mcpJsonContent(
    await client.call(
      "register",
      oneShotRegisterParams({ name: seat.session, launchId: seat.launchId, launchParentPid: seat.launchParentPid }),
    ),
  ) as { readonly name?: unknown }
  if (registered.name !== seat.session) {
    throw new Error(
      `${context.producer}: Tribe registered ${JSON.stringify(registered.name)} instead of the seat ${seat.session} ` +
        `that holds launch ${sender.launchId}`,
    )
  }
  return seat.session
}

export function describeDaemonOutcome(outcome: SendOutcome): string {
  switch (outcome.kind) {
    case "ok":
      return "ok"
    case "timeout":
      return "timed out"
    case "no-daemon":
      return "no daemon (socket refused or absent)"
    case "error":
      return outcome.message
    case "refused":
      return `refused by the daemon: ${outcome.refusal}`
  }
}
