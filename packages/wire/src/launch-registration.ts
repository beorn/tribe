/** One scoped, daemon-certified launch registration shared by agent hosts and service producers. */
import { connectToDaemon, type DaemonClient } from "./client.ts"
import { resolveSocketPath } from "./paths.ts"
import { deriveTribePersonaLaunchIdentity } from "./lib/persona-launch-identity.ts"
import { projectTribeLaunchEnvironment, tribeSessionIdentityEnvironmentNames } from "./launch-environment.ts"
import { TRIBE_PROTOCOL_VERSION, TRIBE_SUPPORTED_PROTOCOL_VERSIONS } from "./lib/socket.ts"

export interface TribeLaunchRequest {
  readonly name: string
  readonly principalClass: "agent" | "service"
  readonly launchId: string
  readonly cwd: string
  readonly domains: readonly string[]
  readonly takeover: boolean
  readonly provider?: string
  readonly account?: string
  /** Agents require certified mailbox authority; sender-only services omit it. */
  readonly mailboxAuthorityHash?: string
}

export interface TribeLaunchConnection {
  readonly joinRetries: number
  readonly launchParentPid: number
  readonly launchId: string
  /** Child-process patch: fresh launch proof and names, with caller authority removed. */
  readonly environment: NodeJS.ProcessEnv
  isConnected(): boolean
  /** Disconnect the owner. Service authority expires; agents retain recovery semantics. */
  close(): void
}

type TribeLaunchClient = Pick<DaemonClient, "call" | "close"> & {
  readonly socket: Pick<DaemonClient["socket"], "unref"> & { readonly destroyed?: boolean }
}

export interface TribeLaunchDeps {
  readonly connect: (socketPath: string, options?: { readonly callTimeoutMs?: number }) => Promise<TribeLaunchClient>
  readonly socketPath: () => string
  readonly sleep: (milliseconds: number) => Promise<void>
  readonly processId: () => number
}

const CONNECT_ATTEMPTS = 3
const CONNECT_TIMEOUT_MS = 5_000
const defaultTribeLaunchDeps: TribeLaunchDeps = {
  connect: connectToDaemon,
  socketPath: resolveSocketPath,
  sleep: (milliseconds) =>
    new Promise((resolve) => {
      setTimeout(resolve, milliseconds)
    }),
  processId: () => process.pid,
}

export async function connectTribeLaunch(
  request: TribeLaunchRequest,
  deps: TribeLaunchDeps = defaultTribeLaunchDeps,
): Promise<TribeLaunchConnection> {
  let lastError: unknown
  for (let attempt = 0; attempt < CONNECT_ATTEMPTS; attempt++) {
    let client: TribeLaunchClient | undefined
    try {
      const processId = deps.processId()
      const identity = deriveTribePersonaLaunchIdentity(request.name, request.launchId)
      client = await deps.connect(deps.socketPath(), { callTimeoutMs: CONNECT_TIMEOUT_MS })
      const registration = (await client.call("register", {
        name: request.name,
        role: "member",
        principalClass: request.principalClass,
        domains: [...request.domains],
        project: request.cwd,
        peerSocket: null,
        pid: processId,
        // Advertise the rolling compatibility window, exactly as the wire CLI's
        // send/read paths do. The legacy scalar deliberately stays at N-1 so a
        // daemon that predates `supportedProtocolVersions` still accepts us;
        // a current daemon negotiates up from the array. Sending a bare
        // TRIBE_PROTOCOL_VERSION here made every launch fail against a v9
        // daemon — no Codex seat could start at all — because this bootstrap is
        // a fourth register call site living outside vendor/tribe, and the
        // window was only ever wired into the three inside it.
        protocolVersion: TRIBE_PROTOCOL_VERSION - 1,
        supportedProtocolVersions: [...TRIBE_SUPPORTED_PROTOCOL_VERSIONS],
        launchId: identity.launchId,
        launchParentPid: processId,
        delivery: "pull",
        ...(request.provider === undefined ? {} : { provider: request.provider }),
        ...(request.mailboxAuthorityHash === undefined ? {} : { mailboxAuthorityHash: request.mailboxAuthorityHash }),
        ...(request.account === undefined ? {} : { account: request.account }),
        takeover: request.takeover,
      })) as { readonly name?: unknown; readonly principalClass?: unknown }
      if (registration.name !== request.name) {
        throw new Error(
          `Tribe registered ${JSON.stringify(registration.name)} instead of ${JSON.stringify(request.name)}`,
        )
      }
      if (request.principalClass === "service" && registration.principalClass !== "service") {
        throw new Error(
          `Tribe did not certify service lifetime for ${request.name}; the daemon must support service principals`,
        )
      }
      const certification = exactLaunchMember(await client.call("tribe.members", {}), {
        persona: request.name,
        launchId: identity.launchId,
        launchParentPid: processId,
        ...(request.provider === undefined ? {} : { provider: request.provider }),
        account: request.account,
        cwd: request.cwd,
        requireMailboxAuthority: request.mailboxAuthorityHash !== undefined,
      })
      if (certification.member === null) {
        throw new Error(
          `Tribe member row did not certify ${request.name} launch ${identity.launchId} under harness pid ${processId}` +
            (certification.mailboxReadCapabilityDetail === null
              ? ""
              : `: ${certification.mailboxReadCapabilityDetail}`),
        )
      }
      // The caller owns this lifetime. A live socket cannot keep a finished
      // service occurrence or provider host alive by itself.
      client.socket.unref()
      const registeredClient = client
      return {
        joinRetries: attempt,
        launchParentPid: processId,
        launchId: identity.launchId,
        environment: {
          ...Object.fromEntries(tribeSessionIdentityEnvironmentNames().map((key) => [key, undefined])),
          ...projectTribeLaunchEnvironment(identity.launchId),
          TRIBE_LAUNCH_PARENT_PID: String(processId),
          TRIBE_NAME: request.name,
          TRIBE_SESSION_NAME: request.name,
        },
        isConnected: () => registeredClient.socket.destroyed !== true,
        close: () => registeredClient.close(),
      }
    } catch (error) {
      client?.close()
      lastError = error
      if (attempt + 1 < CONNECT_ATTEMPTS) {
        await deps.sleep(100 * (attempt + 1))
      }
    }
  }
  throw new Error(
    `managed Tribe bootstrap failed after ${CONNECT_ATTEMPTS} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  )
}

function exactLaunchMember(
  result: unknown,
  expected: {
    readonly persona: string
    readonly launchId: string
    readonly launchParentPid: number
    readonly provider?: string
    readonly account?: string
    readonly cwd: string
    readonly requireMailboxAuthority: boolean
  },
): { readonly member: object | null; readonly mailboxReadCapabilityDetail: string | null } {
  const text = (result as { readonly content?: readonly [{ readonly text?: unknown }] }).content?.[0]?.text
  if (typeof text !== "string") return { member: null, mailboxReadCapabilityDetail: null }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { member: null, mailboxReadCapabilityDetail: null }
  }
  const rawSessions = (parsed as { readonly sessions?: unknown }).sessions
  if (!Array.isArray(rawSessions)) return { member: null, mailboxReadCapabilityDetail: null }
  const sessions: readonly unknown[] = rawSessions
  let mailboxReadCapabilityDetail: string | null = null
  for (const candidate of sessions) {
    if (typeof candidate !== "object" || candidate === null) continue
    const member = candidate as Record<string, unknown>
    if (
      member["name"] !== expected.persona ||
      member["launch_id"] !== expected.launchId ||
      member["launch_parent_pid"] !== expected.launchParentPid ||
      member["transport_state"] !== "connected" ||
      member["delivery"] !== "pull" ||
      member["alive"] !== true ||
      (expected.provider === undefined
        ? member["provider"] !== undefined && member["provider"] !== null
        : member["provider"] !== expected.provider) ||
      (expected.account === undefined
        ? member["account"] !== undefined && member["account"] !== null
        : member["account"] !== expected.account) ||
      member["cwd"] !== expected.cwd
    ) {
      continue
    }
    if (!expected.requireMailboxAuthority) return { member, mailboxReadCapabilityDetail: null }
    const mailboxReadCapability = member["mailbox_read_capability"]
    if (
      typeof mailboxReadCapability === "object" &&
      mailboxReadCapability !== null &&
      (mailboxReadCapability as Record<string, unknown>)["state"] === "available" &&
      (mailboxReadCapability as Record<string, unknown>)["evidence_kind"] === "observed" &&
      (mailboxReadCapability as Record<string, unknown>)["reason"] === "self-mailbox-authority-registered"
    ) {
      return { member, mailboxReadCapabilityDetail: null }
    }
    const capability =
      typeof mailboxReadCapability === "object" && mailboxReadCapability !== null
        ? (mailboxReadCapability as Record<string, unknown>)
        : null
    mailboxReadCapabilityDetail ??=
      `mailbox_read_capability state=${JSON.stringify(capability?.["state"])} ` +
      `reason=${JSON.stringify(capability?.["reason"])}`
  }
  return { member: null, mailboxReadCapabilityDetail }
}
