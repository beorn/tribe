/**
 * Tribe's process-boundary launch name (25074 3d-2b). A launch id travels structurally between launchers, and an
 * adapter keys by its identity token's sid; nothing reads or projects TRIBE_LAUNCH_ID (its clear went in 3d-3). The
 * parent hint below is still projected by a certified launch registration, so a new launch clears an inherited one.
 */

const INHERITED_PARENT_PID_ENV = "TRIBE_LAUNCH_PARENT_PID"

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
  "TRIBE_ACCOUNT",
  "TRIBE_DOMAINS",
  INHERITED_PARENT_PID_ENV,
  "TRIBE_NAME",
  "TRIBE_PLUGIN_ADAPTER_CHILD",
  "TRIBE_PLUGIN_ADAPTER_EXIT_RECORD",
  "TRIBE_PLUGIN_PROVIDER_PARENT_PID",
  "TRIBE_PLUGIN_REEXEC_EXIT_CODE",
  "TRIBE_PLUGIN_RESUME_JOINED",
  "TRIBE_PROVIDER",
  "TRIBE_ROLE",
  "TRIBE_SESSION_NAME",
  "TRIBE_SLA_ROLE",
  "TRIBE_TAKEOVER",
] as const

export function tribeSessionIdentityEnvironmentNames(): readonly string[] {
  return SESSION_IDENTITY_ENV
}
