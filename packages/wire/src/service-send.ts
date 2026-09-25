/**
 * The ONE one-shot tribe daemon client service producers share (`hab attention`, `hab page
 * project`, `ag quota wall`): a pile read needs no identity; a send certifies a service launch
 * on the same socket so the daemon attributes the message to that producer (25689: moved here
 * from hab-cli so both CLIs share one copy).
 */
import { randomUUID } from "node:crypto"
import { connectTribeLaunch } from "./launch-registration.ts"
import { readIdentityTokenFromEnvironment } from "./lib/identity-token.ts"
import { resolveSocketPath } from "./paths.ts"
import { withDaemonCall, type DaemonCallOutcome } from "./util.ts"

/** Whole connect+call budget per daemon operation; tribe.health took ~5s under load. */
export const TRIBE_DAEMON_DEADLINE_MS = 10_000

export interface TribeDaemonCalls {
  /** `tribe.pending {owner}` — the open balls `owner` must answer; needs no identity. */
  pendingFor(owner: string): Promise<DaemonCallOutcome<unknown>>
  /** `tribe.members {all: true}` — every session row the daemon has, disconnected included; needs no identity. */
  members(): Promise<DaemonCallOutcome<unknown>>
  /** Certify a service launch on this socket, then `tribe.send` with these params VERBATIM. */
  sendAs(params: Readonly<Record<string, unknown>>): Promise<DaemonCallOutcome<unknown>>
}

export function tribeDaemonCalls(
  producer: string,
  opts: {
    socketPath?: string
    deadlineMs?: number
    /** Where the launch's identity token is read (HAB_ID_TOKEN); the process environment by default. */
    env?: Readonly<NodeJS.ProcessEnv>
    /** Where the minted-id transition notice goes; stderr by default. */
    say?: (line: string) => void
  } = {},
): TribeDaemonCalls {
  const socketPath = opts.socketPath ?? resolveSocketPath()
  const deadlineMs = opts.deadlineMs ?? TRIBE_DAEMON_DEADLINE_MS
  const say = opts.say ?? ((line: string) => process.stderr.write(line))
  return {
    pendingFor: (owner) =>
      withDaemonCall({ socketPath, deadlineMs }, (client) => client.call("tribe.pending", { owner })),
    members: () => withDaemonCall({ socketPath, deadlineMs }, (client) => client.call("tribe.members", { all: true })),
    sendAs: (params) =>
      withDaemonCall({ socketPath, deadlineMs, callTimeoutMs: deadlineMs }, async (client) => {
        await connectTribeLaunch(
          {
            ...serviceSendLaunch(producer, readIdentityTokenFromEnvironment(opts.env ?? process.env), say),
            principalClass: "service",
            cwd: process.cwd(),
            domains: ["service"],
            takeover: false,
          },
          {
            connect: () => Promise.resolve(client),
            socketPath: () => socketPath,
            sleep: (ms) =>
              new Promise((resolve) => {
                setTimeout(resolve, ms)
              }),
            processId: () => process.pid,
          },
        )
        return client.call("tribe.send", params)
      }),
  }
}

/**
 * Who a send registers as (25074 3d prerequisite, @cto 6fd50bd0). A hab-launched process registers as its own launch:
 * the name its token's actor claim names and the launch its sid names, never the producer's name, which the daemon
 * would refuse as identity-name-mismatch when another job sends it (wait-watch from attention-watch, hab-page from
 * page-mailbox-projection). The producer travels in the message itself (an incident's emitter, a page's line). A
 * process with no token (a hand run) registers as the producer on a minted id and says so: 3d deletes that arm.
 */
function serviceSendLaunch(
  producer: string,
  idToken: string | null,
  say: (line: string) => void,
): { readonly name: string; readonly idToken: string } | { readonly name: string; readonly launchId: string } {
  if (idToken !== null) return { name: tokenActorClaim(idToken) ?? producer, idToken }
  const minted = randomUUID()
  say(
    `${producer}: registered on a minted launch id ${minted}, with no identity token of its own; ` +
      "this is the transition 25074 3d deletes\n",
  )
  return { name: producer, launchId: minted }
}

/** The actor (`act.sub`) of a JWT-shaped identity token, read without verifying it; the daemon verifies. */
function tokenActorClaim(token: string): string | undefined {
  const payload = token.split(".")[1]
  if (payload === undefined) return undefined
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      readonly act?: { sub?: unknown }
    }
    const sub = claims.act?.sub
    return typeof sub === "string" && sub.length > 0 ? sub : undefined
  } catch {
    // silent-fallback-allow: an unreadable claim set is the daemon's to judge (unreadable); the producer name is then
    // claimed and the daemon's verdict on the token decides the register.
    return undefined
  }
}

export function describeDaemonOutcome(outcome: DaemonCallOutcome<unknown>): string {
  switch (outcome.kind) {
    case "ok":
      return "ok"
    case "timeout":
      return "timed out"
    case "no-daemon":
      return "no daemon (socket refused or absent)"
    case "error":
      return outcome.message
  }
}
