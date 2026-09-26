/**
 * Tribe's session identity variable names, and the harness session and bead actor names tribe strips with them,
 * each defined once (25074 one stripper S2c, @cto 559259ad, c04ba94d). Import-free on purpose: a package that
 * reads one of these imports this lib subpath, never tribe-wire's index. launch-environment.ts builds the stripper
 * list from these constants and re-exports them.
 */

export const TRIBE_LAUNCH_PARENT_PID_ENV = "TRIBE_LAUNCH_PARENT_PID"
export const TRIBE_ACCOUNT_ENV = "TRIBE_ACCOUNT"
export const TRIBE_DOMAINS_ENV = "TRIBE_DOMAINS"
export const TRIBE_NAME_ENV = "TRIBE_NAME"
export const TRIBE_PLUGIN_ADAPTER_CHILD_ENV = "TRIBE_PLUGIN_ADAPTER_CHILD"
export const TRIBE_PLUGIN_ADAPTER_EXIT_RECORD_ENV = "TRIBE_PLUGIN_ADAPTER_EXIT_RECORD"
export const TRIBE_PLUGIN_PROVIDER_PARENT_PID_ENV = "TRIBE_PLUGIN_PROVIDER_PARENT_PID"
export const TRIBE_PLUGIN_REEXEC_EXIT_CODE_ENV = "TRIBE_PLUGIN_REEXEC_EXIT_CODE"
export const TRIBE_PLUGIN_RESUME_JOINED_ENV = "TRIBE_PLUGIN_RESUME_JOINED"
export const TRIBE_PROVIDER_ENV = "TRIBE_PROVIDER"
export const TRIBE_ROLE_ENV = "TRIBE_ROLE"
export const TRIBE_SESSION_NAME_ENV = "TRIBE_SESSION_NAME"
export const TRIBE_SLA_ROLE_ENV = "TRIBE_SLA_ROLE"
export const TRIBE_TAKEOVER_ENV = "TRIBE_TAKEOVER"
export const CLAUDE_SESSION_ID_ENV = "CLAUDE_SESSION_ID"
export const CLAUDE_SESSION_NAME_ENV = "CLAUDE_SESSION_NAME"
export const BD_ACTOR_ENV = "BD_ACTOR"
