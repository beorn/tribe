/**
 * Tribe's process-boundary launch names (25074 3d-2b). A launch id travels structurally between launchers, and an
 * adapter keys by its identity token's sid, so nothing projects TRIBE_LAUNCH_ID any more. These names remain only so an
 * inherited value from an older launcher is cleared.
 */

const LAUNCH_ID_ENV = "TRIBE_LAUNCH_ID"
const INHERITED_PARENT_PID_ENV = "TRIBE_LAUNCH_PARENT_PID"

/**
 * Start one provider launch with fresh provenance: clear an inherited launch id and parent hint, and project nothing
 * (25074 3d-2b, @cto 0c284929). A launch's id travels structurally between its launchers; its adapter keys by the
 * identity token's sid, and recomputes the real OS parent. The clear stays through the rollover, because a launcher
 * built before 3d-2b still exports both names. Its deletion row is in 3d-3.
 */
export function withTribeLaunchEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, [LAUNCH_ID_ENV]: undefined, [INHERITED_PARENT_PID_ENV]: undefined }
}

/** All caller-owned identity fields; services and daemons share this boundary. */
const SESSION_IDENTITY_ENV = [
  "TRIBE_ACCOUNT",
  "TRIBE_DOMAINS",
  LAUNCH_ID_ENV,
  INHERITED_PARENT_PID_ENV,
  "TRIBE_NAME",
  "TRIBE_PLUGIN_ADAPTER_CHILD",
  "TRIBE_PLUGIN_ADAPTER_EXIT_RECORD",
  "TRIBE_PLUGIN_PROVIDER_PARENT_PID",
  "TRIBE_PLUGIN_REEXEC_EXIT_CODE",
  "TRIBE_PLUGIN_RESUME_JOINED",
  "TRIBE_PROVIDER",
  "TRIBE_ROLE",
  "AG_SESSION_AUTH",
  "TRIBE_SESSION_NAME",
  "TRIBE_SLA_ROLE",
  "TRIBE_TAKEOVER",
] as const

export function tribeSessionIdentityEnvironmentNames(): readonly string[] {
  return SESSION_IDENTITY_ENV
}
