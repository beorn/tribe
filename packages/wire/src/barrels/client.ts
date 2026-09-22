/**
 * tribe-wire/client — the daemon-calling sub-barrel.
 *
 * Everything a consumer needs to TALK TO the daemon: connect, reconnect,
 * deadline-bounded call, socket-path discovery, and launch registration.
 *
 * Closure is 12 files and it deliberately INCLUDES launch-environment, which is
 * why this barrel re-exports it below. A consumer that needs both a daemon call
 * and a launch id imports this ONE subpath and pays 12 files, rather than
 * importing the root barrel and paying all 30 (24965; measured in 24905).
 *
 * If you need ONLY a launch id and make no daemon call, import
 * `tribe-wire/launch-environment` instead — 1 file, zero imports.
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

// Launch identity. Already inside this barrel's closure via launch-registration,
// so re-exporting costs nothing and saves a straddling consumer a second import.
export type { TribeLaunchEnvironment } from "../launch-environment.ts"
export {
  projectTribeLaunchEnvironment,
  readTribeLaunchId,
  tribeLaunchEnvironmentNames,
  tribeSessionIdentityEnvironmentNames,
  withTribeLaunchEnvironment,
} from "../launch-environment.ts"

// JSON-RPC framing and the line parser. Already inside this barrel's closure
// (client.ts imports both), so a consumer that fakes a daemon in a test takes
// them from here rather than the root barrel.
export type { JsonRpcMessage, JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from "../rpc.ts"
export { isNotification, isRequest, isResponse, makeError, makeNotification, makeRequest, makeResponse } from "../rpc.ts"
export { createLineParser } from "../parser.ts"
