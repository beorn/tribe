/**
 * Environment ownership at the Tribe daemon process boundary.
 *
 * Agent/session identity belongs to the caller and must never become daemon
 * identity. Standalone lifecycle markers and an operator-capability fd belong
 * only to the supervisor that minted them.
 */

import { existsSync, fstatSync } from "node:fs"
import { join } from "node:path"
import { tribeSessionIdentityEnvironmentNames } from "./launch-environment.ts"

/**
 * Variables that prove hab launched this process, WITHOUT proving it is
 * hab-managed. `sanitizeStandaloneDaemonEnvironment` deliberately strips the
 * management markers (`HAB_SESSION_DIR`, `HAB_SERVICE_KIND`, `HAB_SERVICE_NAME`)
 * and leaves these, so these are exactly the evidence that hab is present when
 * the management markers are gone. Defined beside the sanitizer that makes that
 * true; the daemon's health source and the client spawn gate both read it here.
 */
export const HAB_SESSION_HABITAT_ROOT_ENV = "HAB_SESSION_HABITAT_ROOT"

export const HAB_SESSION_MARKERS = [
  HAB_SESSION_HABITAT_ROOT_ENV,
  "HAB_SESSION_LAUNCH_ID",
  "HAB_SESSION_INSTRUCTION_ANCHOR",
] as const

/** The declared roster, inline and by file; the daemon's roster reader and the standalone sanitizer both read them. */
export const TRIBE_EXPECTED_MEMBERS_ENV = "TRIBE_EXPECTED_MEMBERS"
export const TRIBE_EXPECTED_MEMBERS_FILE_ENV = "TRIBE_EXPECTED_MEMBERS_FILE"

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
  // 24589 row 3 / 24591: a client's TRIBE_EXPECTED_MEMBERS is frozen at that
  // client's launch. When hab has pinned the JSON on disk, drop the inherited
  // snapshot so the daemon cannot quote a list older than the config.
  const habitatRoot = env[HAB_SESSION_HABITAT_ROOT_ENV]
  const habitatFile = habitatRoot?.trim() ? join(habitatRoot, "tribe-expected-members.json") : undefined
  if (env[TRIBE_EXPECTED_MEMBERS_FILE_ENV]?.trim() || (habitatFile !== undefined && existsSync(habitatFile))) {
    delete env[TRIBE_EXPECTED_MEMBERS_ENV]
  }
  return env
}

/**
 * The ambient names tribe reads (24644; @cto's fixture-environment amendment
 * and 14f4c81e, 2026-09-23): session identity, the declared-roster pair, the
 * LLM-sender classification, delivery fallbacks, and the habitat root the
 * daemon reads its pinned roster from. A disposable fixture deletes these
 * rather than inheriting them, since inheriting any makes a test's result a
 * function of who ran it and when their seat launched. Never PATH or HOME.
 * Each package owns its own list; this is tribe's, and a name comes from its
 * reader's constant wherever the reader has one.
 */
export function tribeAmbientEnvironmentNames(): readonly string[] {
  return [
    ...tribeSessionIdentityEnvironmentNames(),
    TRIBE_EXPECTED_MEMBERS_ENV,
    TRIBE_EXPECTED_MEMBERS_FILE_ENV,
    "CLAUDE_SESSION_ID",
    "CLAUDE_SESSION_NAME",
    "BD_ACTOR",
    "TRIBE_DELIVERY_FALLBACKS",
    HAB_SESSION_HABITAT_ROOT_ENV,
  ]
}
