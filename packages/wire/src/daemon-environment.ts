/**
 * Environment ownership at the Tribe daemon process boundary.
 *
 * Agent/session identity belongs to the caller and must never become daemon
 * identity. Standalone lifecycle markers and an operator-capability fd belong
 * only to the supervisor that minted them.
 */

import { fstatSync } from "node:fs"
import { tribeSessionIdentityEnvironmentNames } from "./launch-environment.ts"

export const TRIBE_OPERATOR_CAPABILITY_FD_ENV = "TRIBE_OPERATOR_CAPABILITY_FD"
export const TRIBE_OPERATOR_CAPABILITY_ENV = "TRIBE_OPERATOR_CAPABILITY"
export const TRIBE_DAEMON_SUPERVISOR_PID_ENV = "TRIBE_DAEMON_SUPERVISOR_PID"
export const TRIBE_DAEMON_RELOAD_EXIT_CODE_ENV = "TRIBE_DAEMON_RELOAD_EXIT_CODE"

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
  for (const key of tribeSessionIdentityEnvironmentNames()) delete env[key]
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
  // HAB_SERVICE_NAME drives the hab-managed idle-quit default (never quit).
  // A standalone daemon minted FROM a hab-supervised session is not itself
  // hab-managed — without this strip it would inherit the marker and never
  // retire, the daemon-leak inverse of the 2026-08-12 rail outage.
  delete env.HAB_SERVICE_NAME
  delete env.HAB_SESSION_DIR
  delete env[TRIBE_DAEMON_RELOAD_EXIT_CODE_ENV]
  delete env[TRIBE_DAEMON_SUPERVISOR_PID_ENV]
  delete env[TRIBE_OPERATOR_CAPABILITY_FD_ENV]
  return env
}
