/**
 * The ONE one-shot tribe daemon client service producers share (`hab attention`, `hab page
 * project`, `ag quota wall`): a pile read needs no identity; a send certifies a service launch
 * on the same socket so the daemon attributes the message to that producer (25689: moved here
 * from hab-cli so both CLIs share one copy).
 */
import { randomUUID } from "node:crypto"
import { connectTribeLaunch } from "./launch-registration.ts"
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
  opts: { socketPath?: string; deadlineMs?: number } = {},
): TribeDaemonCalls {
  const socketPath = opts.socketPath ?? resolveSocketPath()
  const deadlineMs = opts.deadlineMs ?? TRIBE_DAEMON_DEADLINE_MS
  return {
    pendingFor: (owner) =>
      withDaemonCall({ socketPath, deadlineMs }, (client) => client.call("tribe.pending", { owner })),
    members: () => withDaemonCall({ socketPath, deadlineMs }, (client) => client.call("tribe.members", { all: true })),
    sendAs: (params) =>
      withDaemonCall({ socketPath, deadlineMs, callTimeoutMs: deadlineMs }, async (client) => {
        await connectTribeLaunch(
          {
            name: producer,
            principalClass: "service",
            launchId: randomUUID(),
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
