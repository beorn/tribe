/**
 * Tribe's process-boundary launch name (25074 3d-2b). A launch id travels structurally between launchers, and an
 * adapter keys by its identity token's sid; nothing reads or projects TRIBE_LAUNCH_ID (its clear went in 3d-3). The
 * parent hint below is still projected by a certified launch registration, so a new launch clears an inherited one.
 */

import { HAB_ID_TOKEN_ENV } from "./lib/identity-token.ts"
import {
  BD_ACTOR_ENV,
  CLAUDE_SESSION_ID_ENV,
  CLAUDE_SESSION_NAME_ENV,
  TRIBE_ACCOUNT_ENV,
  TRIBE_DOMAINS_ENV,
  TRIBE_LAUNCH_PARENT_PID_ENV,
  TRIBE_NAME_ENV,
  TRIBE_PLUGIN_ADAPTER_CHILD_ENV,
  TRIBE_PLUGIN_ADAPTER_EXIT_RECORD_ENV,
  TRIBE_PLUGIN_PROVIDER_PARENT_PID_ENV,
  TRIBE_PLUGIN_REEXEC_EXIT_CODE_ENV,
  TRIBE_PLUGIN_RESUME_JOINED_ENV,
  TRIBE_PROVIDER_ENV,
  TRIBE_ROLE_ENV,
  TRIBE_SESSION_NAME_ENV,
  TRIBE_SLA_ROLE_ENV,
  TRIBE_TAKEOVER_ENV,
} from "./lib/session-identity-env.ts"

export {
  BD_ACTOR_ENV,
  CLAUDE_SESSION_ID_ENV,
  CLAUDE_SESSION_NAME_ENV,
  TRIBE_ACCOUNT_ENV,
  TRIBE_DOMAINS_ENV,
  TRIBE_LAUNCH_PARENT_PID_ENV,
  TRIBE_NAME_ENV,
  TRIBE_PLUGIN_ADAPTER_CHILD_ENV,
  TRIBE_PLUGIN_ADAPTER_EXIT_RECORD_ENV,
  TRIBE_PLUGIN_PROVIDER_PARENT_PID_ENV,
  TRIBE_PLUGIN_REEXEC_EXIT_CODE_ENV,
  TRIBE_PLUGIN_RESUME_JOINED_ENV,
  TRIBE_PROVIDER_ENV,
  TRIBE_ROLE_ENV,
  TRIBE_SESSION_NAME_ENV,
  TRIBE_SLA_ROLE_ENV,
  TRIBE_TAKEOVER_ENV,
}

const INHERITED_PARENT_PID_ENV = TRIBE_LAUNCH_PARENT_PID_ENV

/**
 * Start one provider launch with fresh provenance: clear an inherited parent hint, and project nothing (25074 3d-2b,
 * @cto 0c284929). A launch's id travels structurally between its launchers; its adapter keys by the identity token's
 * sid, and recomputes the real OS parent.
 */
export function withTribeLaunchEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, [INHERITED_PARENT_PID_ENV]: undefined }
}

/** All caller-owned identity fields; services and daemons share this boundary. */
const SESSION_IDENTITY_ENV = [
  TRIBE_ACCOUNT_ENV,
  TRIBE_DOMAINS_ENV,
  INHERITED_PARENT_PID_ENV,
  TRIBE_NAME_ENV,
  TRIBE_PLUGIN_ADAPTER_CHILD_ENV,
  TRIBE_PLUGIN_ADAPTER_EXIT_RECORD_ENV,
  TRIBE_PLUGIN_PROVIDER_PARENT_PID_ENV,
  TRIBE_PLUGIN_REEXEC_EXIT_CODE_ENV,
  TRIBE_PLUGIN_RESUME_JOINED_ENV,
  TRIBE_PROVIDER_ENV,
  TRIBE_ROLE_ENV,
  TRIBE_SESSION_NAME_ENV,
  TRIBE_SLA_ROLE_ENV,
  TRIBE_TAKEOVER_ENV,
] as const

export function tribeSessionIdentityEnvironmentNames(): readonly string[] {
  return SESSION_IDENTITY_ENV
}

/**
 * Every key by which a child claims or inherits WHO it is on the wire (25074, @cto 559259ad): tribe's session
 * identity, the launch's signed token, the harness session and the bead actor. A launch boundary strips all of them
 * (hab-core's scrubCallerIdentity reads this list), so a process started from a seat's pane never reads, writes or
 * speaks as that seat. Configuration such as the expected-members roster or the habitat root is not identity and is
 * not here; tribeAmbientEnvironmentNames adds it for fixtures.
 */
export function launchIdentityEnvironmentNames(): readonly string[] {
  return [...SESSION_IDENTITY_ENV, HAB_ID_TOKEN_ENV, CLAUDE_SESSION_ID_ENV, CLAUDE_SESSION_NAME_ENV, BD_ACTOR_ENV]
}
