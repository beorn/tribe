/** One scoped, daemon-certified launch registration shared by agent hosts and service producers. */
import { connectToDaemon, type DaemonClient } from "./client.ts"
import { resolveSocketPath } from "./paths.ts"
import { deriveTribePersonaLaunchIdentity, providerLaunchIdOf } from "./lib/persona-launch-identity.ts"
import { projectTribeLaunchEnvironment, tribeSessionIdentityEnvironmentNames } from "./launch-environment.ts"
import { TRIBE_PROTOCOL_VERSION, TRIBE_SUPPORTED_PROTOCOL_VERSIONS } from "./lib/socket.ts"

export interface TribeLaunchRequest {
  readonly name: string
  readonly principalClass: "agent" | "service"
  /**
   * The launch id this process was given. Absent, it is the identity token's `sid` claim (25074 §18(a), @cto
   * 027f0c0c): a hab-launched sender presents the launch it was given, never a minted one. A supplied id that is not the
   * token's sid is refused naming both; neither an id nor a token is refused.
   */
  readonly launchId?: string
  readonly cwd: string
  readonly domains: readonly string[]
  readonly takeover: boolean
  readonly provider?: string
  readonly account?: string
  /** Agents require certified mailbox authority; sender-only services omit it. */
  readonly mailboxAuthorityHash?: string
  /** The launch's identity token (25074 3b), verified by the daemon's composing-layer verifier when it has one. */
  readonly idToken?: string
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
  const providerLaunchId = launchIdFor(request)
  let lastError: unknown
  for (let attempt = 0; attempt < CONNECT_ATTEMPTS; attempt++) {
    let client: TribeLaunchClient | undefined
    try {
      const processId = deps.processId()
      const identity = deriveTribePersonaLaunchIdentity(request.name, providerLaunchId)
      // 25074 (@cto 95c2be2d): the client never omits the launch id it was given. A register with a token sends both,
      // the daemon decides the keying (`<sid>@<gen>` for a verified token) and returns it, and this client certifies
      // against what the daemon keyed (@cto b58e4715).
      const byToken = request.idToken !== undefined
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
        ...(request.idToken === undefined ? {} : { idToken: request.idToken }),
        ...(request.account === undefined ? {} : { account: request.account }),
        takeover: request.takeover,
      })) as {
        readonly name?: unknown
        readonly principalClass?: unknown
        readonly launchId?: unknown
        readonly launchParentPid?: unknown
      }
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
      const launchId = keyedLaunchId(registration, identity.launchId, byToken, processId)
      const certification = exactLaunchMember(await client.call("tribe.members", {}), {
        persona: request.name,
        launchId,
        launchParentPid: processId,
        ...(request.provider === undefined ? {} : { provider: request.provider }),
        account: request.account,
        cwd: request.cwd,
        requireMailboxAuthority: request.mailboxAuthorityHash !== undefined,
      })
      if (certification.member === null) {
        throw new Error(
          `Tribe member row did not certify ${request.name} launch ${launchId} under harness pid ${processId}` +
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
        launchId,
        environment: {
          ...Object.fromEntries(tribeSessionIdentityEnvironmentNames().map((key) => [key, undefined])),
          // The derived launch id stays projected until 3d; a child sends it beside the token, as this register did.
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
  // The last refusal is the cause, so a caller can read its typed kind (a daemon refusal's `data.kind`) rather than
  // parse the message: 25074 3c's bootstrap falls back to its bearer on an identity-verifier-fault and on nothing else.
  throw new Error(
    `managed Tribe bootstrap failed after ${CONNECT_ATTEMPTS} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
    { cause: lastError },
  )
}

/**
 * The provider launch id this register presents (25074 §18(a)): the one it was given, which must be its token's sid
 * when the token names one, or else that sid. The claim is read unverified — the daemon verifies the token — so a token
 * whose claims cannot be read leaves a supplied id to the daemon's judgement.
 */
function launchIdFor(request: TribeLaunchRequest): string {
  const sid = request.idToken === undefined ? undefined : tokenSidClaim(request.idToken)
  if (request.launchId === undefined) {
    if (sid !== undefined) return sid
    throw new Error(
      request.idToken === undefined
        ? `Tribe register for ${request.name} has neither a launch id nor an identity token`
        : `Tribe register for ${request.name} has no launch id and its identity token names no sid`,
    )
  }
  if (sid !== undefined && sid !== request.launchId) {
    throw new Error(
      `Tribe register refused by this client: launch id ${request.launchId} is not this token's sid ${sid}; ` +
        "a hab-launched sender presents the launch it was given, never a minted one",
    )
  }
  return request.launchId
}

/** The `sid` claim of a JWT-shaped identity token, read without verifying it; undefined when there is none to read. */
function tokenSidClaim(token: string): string | undefined {
  const payload = token.split(".")[1]
  if (payload === undefined) return undefined
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { readonly sid?: unknown }
    return typeof claims.sid === "string" && claims.sid.length > 0 ? claims.sid : undefined
  } catch {
    // silent-fallback-allow: an unreadable claim set is the daemon's to judge (unreadable); this read only forms an id.
    return undefined
  }
}

/**
 * The launch identity this register was keyed under (@cto b58e4715, 95c2be2d). The daemon keys a verified token
 * `<sid>@<gen>`, and the sid is the derived launch id's provider part, so a token register certifies the returned id
 * when it is the derived one or that seat's `<sid>@<gen>`, and refuses any other. Without a token the returned id must
 * equal the derived one. A daemon that returns none keyed the launch id it was sent, so the derived id certifies: an old
 * daemon plus this client keeps joining (@cto 57e5f42a). A returned parent pid that is not this harness's refuses.
 */
function keyedLaunchId(
  registration: { readonly launchId?: unknown; readonly launchParentPid?: unknown },
  derived: string,
  byToken: boolean,
  processId: number,
): string {
  const returned =
    typeof registration.launchId === "string" && registration.launchId.length > 0 ? registration.launchId : null
  if (registration.launchParentPid !== undefined && registration.launchParentPid !== null) {
    if (registration.launchParentPid !== processId) {
      throw new Error(
        `Tribe register refused by this client: the daemon keyed launch parent pid ${String(registration.launchParentPid)}, ` +
          `not this harness's ${processId}`,
      )
    }
  }
  if (returned === null || returned === derived) return derived
  const sid = providerLaunchIdOf(derived)
  if (byToken && returned.startsWith(`${sid}@`) && /^\d+$/u.test(returned.slice(sid.length + 1))) return returned
  throw new Error(
    `Tribe register refused by this client: the daemon keyed launch ${returned}, not the derived ${derived}` +
      (byToken ? ` or its seat's ${sid}@<gen>` : ""),
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
      // 25074 3b: dual-keyed with the daemon's session resolution — a bearer-registered or a token-verified
      // session re-certifies; the two move together or a verified seat fails its own re-certification.
      ((mailboxReadCapability as Record<string, unknown>)["reason"] === "self-mailbox-authority-registered" ||
        (mailboxReadCapability as Record<string, unknown>)["reason"] === "self-mailbox-authority-token")
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
