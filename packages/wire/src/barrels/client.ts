/**
 * tribe-wire/client — the daemon-calling sub-barrel.
 *
 * Everything a consumer needs to TALK TO the daemon: connect, reconnect,
 * deadline-bounded call, socket-path discovery, and launch registration.
 *
 * Closure is 12 files, launch-environment among them (launch-registration
 * imports it), but this barrel does not re-export its names: each name has one
 * subpath (24965, @cto 2e820bc9). A consumer that needs a daemon call and a
 * launch id imports both `tribe-wire/client` and
 * `tribe-wire/launch-environment`; the second adds no file to its graph, and
 * both together are still 12 files against the root barrel's 30 (24905).
 *
 * If you need ONLY a launch id and make no daemon call, import
 * `tribe-wire/launch-environment` alone: 1 file, zero imports.
 */

// Daemon client
export type {
  ConnectOrStartOpts,
  ConnectToDaemonOpts,
  DaemonCallOpts,
  DaemonClient,
  ReconnectingClientOpts,
  StandaloneDaemonSupervisorOpts,
} from "../client.ts"
export {
  connectOrStart,
  connectToDaemon,
  createReconnectingClient,
  isSocketAlive,
  spawnStandaloneDaemonSupervisor,
} from "../client.ts"

// Deadline-bounded call (hook-friendly)
export type { DaemonCallOutcome, WithDaemonCallOpts } from "../util.ts"
export { withDaemonCall } from "../util.ts"

// Socket path discovery
export { resolvePeerSocketPath, resolveSocketPath } from "../paths.ts"

// Launch registration
export { connectTribeLaunch } from "../launch-registration.ts"
export type { TribeLaunchConnection, TribeLaunchDeps, TribeLaunchRequest } from "../launch-registration.ts"

// JSON-RPC framing and the line parser. Already inside this barrel's closure
// (client.ts imports both), so a consumer that fakes a daemon in a test takes
// them from here rather than the root barrel.
export type { JsonRpcMessage, JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from "../rpc.ts"
export {
  isNotification,
  isRequest,
  isResponse,
  makeError,
  makeNotification,
  makeRequest,
  makeResponse,
} from "../rpc.ts"
export { createLineParser } from "../parser.ts"
