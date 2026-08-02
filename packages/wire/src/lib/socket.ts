/**
 * Tribe socket utilities — tribe-flavored facade on top of the package's IPC
 * primitives. Adds the tribe-specific protocol version and `probeDaemonPid`
 * helper, plus `connectOrStart` / `createReconnectingClient` wrappers that
 * keep daemon lifecycle explicit.
 *
 * The wire protocol, line parser, client, and reconnection logic live in
 * the surrounding tribe-wire package; this module just adds the
 * tribe-flavored ergonomics.
 */

import {
  connectOrStart as clientConnectOrStart,
  connectToDaemon as clientConnectToDaemon,
  createReconnectingClient as clientCreateReconnectingClient,
  type ConnectOrStartOpts as ClientConnectOrStartOpts,
  type ConnectToDaemonOpts,
  type DaemonClient,
  type ReconnectingClientOpts as ClientReconnectingClientOpts,
} from "../client.ts"

// ---------------------------------------------------------------------------
// Protocol version (tribe-specific)
// ---------------------------------------------------------------------------

/**
 * Wire-protocol version. Bump on any payload-shape change a client cares about.
 * v10 (current) adds the private reconnect-stable inbox-wait baseline.
 * v9 adds the typed inbox-wait terminal status and MCP host-cut
 * preflight result.
 * v8 added the effective inbox-wait timeout and optional correlated-
 * reply wake control.
 * v7 added the optional register-time `filterMode`, allowing a launch controller
 * to persist push-admission before a session becomes connected.
 * v6 added sender-declared tracked-ball expiry and inbox-wait
 * attention carriage; the per-event reply hint is derived at delivery time,
 * not pushed on the wire.
 * RPCs: `tribe.send` / `tribe.fetch` / `tribe.members` / `tribe.inbox.wait` /
 * `tribe.filter` / `tribe.rename` / `tribe.health` / `tribe.join` /
 * `tribe.reload` / `tribe.retro` / `tribe.chief` / `tribe.claim-chief` /
 * `tribe.release-chief` / `tribe.debug`. See ../CHANGELOG.md for the wire
 * protocol history.
 */
export const TRIBE_PROTOCOL_VERSION = 10

/**
 * Protocol versions this checkout can speak during a rolling daemon update.
 * Keep the newest version first so negotiation naturally chooses the highest
 * common version. The legacy scalar below deliberately remains N-1: an older
 * daemon that knows nothing about `supportedProtocolVersions` can still accept
 * a new client during the transition.
 */
export const TRIBE_SUPPORTED_PROTOCOL_VERSIONS = [TRIBE_PROTOCOL_VERSION, TRIBE_PROTOCOL_VERSION - 1] as const

export function supportedProtocolVersionsFromAdvertisement(advertised: unknown, legacy: unknown): number[] {
  const advertisedVersions = Array.isArray(advertised)
    ? advertised.filter((version): version is number => Number.isSafeInteger(version) && version > 0)
    : []
  if (advertisedVersions.length > 0) return [...new Set(advertisedVersions)].sort((a, b) => b - a)
  return Number.isSafeInteger(legacy) && Number(legacy) > 0 ? [Number(legacy)] : []
}

export function negotiateProtocolVersion(
  clientVersions: readonly number[],
  daemonVersions: readonly number[] = TRIBE_SUPPORTED_PROTOCOL_VERSIONS,
): number | null {
  const daemonSet = new Set(daemonVersions)
  return clientVersions.find((version) => daemonSet.has(version)) ?? null
}

export function isSupportedProtocolVersion(version: unknown): boolean {
  return Number.isSafeInteger(version) && TRIBE_SUPPORTED_PROTOCOL_VERSIONS.includes(version as number)
}

export function protocolVersionMismatchMessage(
  clientVersions: readonly number[],
  daemonVersions: readonly number[] = TRIBE_SUPPORTED_PROTOCOL_VERSIONS,
): string {
  const clientLabel = clientVersions.length > 0 ? clientVersions.join(",") : "unknown"
  const daemonLabel = daemonVersions.join(",")
  const clientNewest = clientVersions[0]
  const daemonNewest = daemonVersions[0]
  const action =
    clientNewest !== undefined && daemonNewest !== undefined && clientNewest < daemonNewest
      ? `Upgrade the Tribe client to v${daemonVersions.at(-1)} or newer, then reconnect.`
      : `Advance the Tribe daemon to v${clientNewest ?? daemonNewest} or newer, then reconnect.`
  return `Protocol version mismatch: client=${clientLabel}; daemon=${daemonNewest ?? "unknown"}; supported=${daemonLabel}. ${action}`
}

// ---------------------------------------------------------------------------
// Re-exports from the surrounding tribe-client package
// ---------------------------------------------------------------------------

export { connectExisting, connectToDaemon, isSocketAlive, waitForSocketAlive } from "../client.ts"
export { createLineParser } from "../parser.ts"
export {
  isNotification,
  isRequest,
  isResponse,
  makeError,
  makeNotification,
  makeRequest,
  makeResponse,
} from "../rpc.ts"
export { resolvePeerSocketPath, resolveSocketPath } from "../paths.ts"

export type { DaemonCallOpts, DaemonClient } from "../client.ts"
export type { JsonRpcMessage, JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from "../rpc.ts"

// ---------------------------------------------------------------------------
// Tribe-flavored connectOrStart / createReconnectingClient.
//
// These wrap the lower-level client versions to append tribe daemon args when
// a standalone lifecycle surface explicitly opts into spawning. The wire
// package itself does not guess a daemon path: provider-owned `tribe-wire mcp`
// connects to an existing/forwarded socket and sets `noSpawn`.
// ---------------------------------------------------------------------------

export type ConnectOrStartOpts = {
  daemonScript?: string
  dbPath?: string
  callTimeoutMs?: number
  noSpawn?: boolean
  maxStartupAttempts?: number
}

export type ReconnectingClientOpts = {
  socketPath: string
  onConnect: (client: DaemonClient) => Promise<void>
  onDisconnect?: () => void
  onReconnect?: () => void
  onReconnectExhausted?: (error: unknown, attempts: number) => void
  maxAttempts?: number
  callTimeoutMs?: number
  noSpawn?: boolean
  dbPath?: string
}

function defaultDaemonScript(): string | undefined {
  if (process.env.TRIBE_DAEMON_SCRIPT) return process.env.TRIBE_DAEMON_SCRIPT
  return undefined
}

function toClientOpts(opts?: ConnectOrStartOpts): ClientConnectOrStartOpts {
  return {
    daemonScript: opts?.daemonScript ?? defaultDaemonScript(),
    daemonArgs: opts?.dbPath ? ["--db", opts.dbPath] : undefined,
    callTimeoutMs: opts?.callTimeoutMs,
    noSpawn: opts?.noSpawn,
    maxStartupAttempts: opts?.maxStartupAttempts,
  }
}

export function connectOrStart(socketPath: string, opts?: ConnectOrStartOpts): Promise<DaemonClient> {
  return clientConnectOrStart(socketPath, toClientOpts(opts))
}

export function createReconnectingClient(opts: ReconnectingClientOpts): Promise<DaemonClient> {
  const clientOpts: ClientReconnectingClientOpts = {
    socketPath: opts.socketPath,
    onConnect: opts.onConnect,
    onDisconnect: opts.onDisconnect,
    onReconnect: opts.onReconnect,
    onReconnectExhausted: opts.onReconnectExhausted,
    maxAttempts: opts.maxAttempts,
    callTimeoutMs: opts.callTimeoutMs,
    noSpawn: opts.noSpawn,
    daemonScript: defaultDaemonScript(),
    daemonArgs: opts.dbPath ? ["--db", opts.dbPath] : undefined,
  }
  return clientCreateReconnectingClient(clientOpts)
}

// ---------------------------------------------------------------------------
// Liveness probe (tribe-specific: speaks `cli_daemon` to grab the PID)
// ---------------------------------------------------------------------------

/**
 * Probe the daemon's liveness by connecting to its socket and asking for its PID.
 * Replaces the old pidfile-based check: if a client can open + speak to the
 * socket, the daemon is alive (kernel owns the liveness proof — no on-disk
 * state to go stale). Returns the daemon's own PID, or null if not reachable.
 */
export async function probeDaemonPid(socketPath: string): Promise<number | null> {
  let client: DaemonClient
  try {
    client = await clientConnectToDaemon(socketPath)
  } catch {
    return null
  }
  try {
    const result = (await client.call("cli_daemon")) as { pid?: number }
    return typeof result.pid === "number" ? result.pid : null
  } catch {
    return null
  } finally {
    try {
      client.close()
    } catch {
      /* ignore */
    }
  }
}

// Re-export the per-call options type so existing tribe callers that reach
// for `ConnectToDaemonOpts` keep working.
export type { ConnectToDaemonOpts }
