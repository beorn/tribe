/**
 * Environment ownership at the Tribe daemon process boundary.
 *
 * Agent/session identity belongs to the caller and must never become daemon
 * identity. Standalone lifecycle markers and an operator-capability fd belong
 * only to the supervisor that minted them.
 */

import { fstatSync } from "node:fs"

export const TRIBE_OPERATOR_CAPABILITY_FD_ENV = "TRIBE_OPERATOR_CAPABILITY_FD"
export const TRIBE_OPERATOR_CAPABILITY_ENV = "TRIBE_OPERATOR_CAPABILITY"
export const TRIBE_DAEMON_SUPERVISOR_PID_ENV = "TRIBE_DAEMON_SUPERVISOR_PID"
export const TRIBE_DAEMON_RELOAD_EXIT_CODE_ENV = "TRIBE_DAEMON_RELOAD_EXIT_CODE"

const AMBIENT_SESSION_IDENTITY_ENV = [
  "TRIBE_ACCOUNT",
  "TRIBE_DOMAINS",
  "TRIBE_LAUNCH_ID",
  "TRIBE_NAME",
  "TRIBE_PLUGIN_ADAPTER_CHILD",
  "TRIBE_PLUGIN_PROVIDER_PARENT_PID",
  "TRIBE_PLUGIN_REEXEC_EXIT_CODE",
  "TRIBE_PLUGIN_RESUME_JOINED",
  "TRIBE_PROVIDER",
  "TRIBE_ROLE",
  "TRIBE_SESSION_NAME",
  "TRIBE_SLA_ROLE",
  "TRIBE_TAKEOVER",
] as const

export function hasStandaloneDaemonOwner(env: Readonly<NodeJS.ProcessEnv>, parentPid = process.ppid): boolean {
  if (env.HAB_SERVICE_KIND !== undefined) return false
  const supervisorPid = Number(env[TRIBE_DAEMON_SUPERVISOR_PID_ENV])
  const reloadExitCode = Number(env[TRIBE_DAEMON_RELOAD_EXIT_CODE_ENV])
  return (
    Number.isSafeInteger(supervisorPid) &&
    supervisorPid > 1 &&
    supervisorPid === parentPid &&
    Number.isSafeInteger(reloadExitCode) &&
    reloadExitCode > 0 &&
    reloadExitCode <= 255
  )
}

function isOpenInheritedFd(fd: number): boolean {
  try {
    fstatSync(fd)
    return true
  } catch {
    return false
  }
}

function hasDirectInheritedOperatorCapability(env: Readonly<NodeJS.ProcessEnv>): boolean {
  if (env.HAB_SERVICE_KIND !== undefined) return false
  const fd = Number(env[TRIBE_OPERATOR_CAPABILITY_FD_ENV])
  return Number.isSafeInteger(fd) && fd >= 3 && isOpenInheritedFd(fd)
}

/** Sanitize the environment of the daemon process itself, in place. */
export function sanitizeDaemonProcessEnvironment(env: NodeJS.ProcessEnv, parentPid = process.ppid): NodeJS.ProcessEnv {
  const hasStandaloneOwner = hasStandaloneDaemonOwner(env, parentPid)
  const hasDirectOperatorCapability = hasDirectInheritedOperatorCapability(env)
  for (const key of AMBIENT_SESSION_IDENTITY_ENV) delete env[key]
  delete env[TRIBE_OPERATOR_CAPABILITY_ENV]
  if (!hasStandaloneOwner) {
    delete env[TRIBE_DAEMON_RELOAD_EXIT_CODE_ENV]
    delete env[TRIBE_DAEMON_SUPERVISOR_PID_ENV]
  }
  if (!hasStandaloneOwner && !hasDirectOperatorCapability) {
    delete env[TRIBE_OPERATOR_CAPABILITY_FD_ENV]
  }
  return env
}

/** Prepare a clean environment before a standalone supervisor is minted. */
export function sanitizeStandaloneDaemonEnvironment(source: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  const env = { ...source }
  sanitizeDaemonProcessEnvironment(env)
  delete env.HAB_SERVICE_KIND
  delete env.HAB_SESSION_DIR
  delete env[TRIBE_DAEMON_RELOAD_EXIT_CODE_ENV]
  delete env[TRIBE_DAEMON_SUPERVISOR_PID_ENV]
  delete env[TRIBE_OPERATOR_CAPABILITY_FD_ENV]
  return env
}
