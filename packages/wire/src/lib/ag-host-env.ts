/**
 * The AG_HOST_* contract: the variable names the Ag host sets on a launched seat's environment, each defined once
 * (25074 one stripper S2c, @cto 68a3a2cc). They live at tribe-wire, the bottom package every reader reaches, because
 * tribe's claude plugin reads one of them and tribe cannot depend on Ag; @ag/harness re-exports every one, so Ag's
 * readers are unchanged. This leaf has no imports; a new package edge imports its lib subpath instead of
 * tribe-wire's index. Existing Ag readers can use the re-export from @ag/harness.
 */

/** Neutral envelope through which a host marks exact fields as backend-private. */
export const AG_HOST_PRIVATE_BACKEND_ENV_KEYS_ENV = "AG_HOST_PRIVATE_BACKEND_ENV_KEYS"

/** Opaque host launch identifier safe to persist in Ag launch records. */
export const AG_HOST_LAUNCH_ID_ENV = "AG_HOST_LAUNCH_ID"

/**
 * The host supervisor's instance generation for this launch, a nonnegative
 * integer, projected by the host for the process its supervisor started.
 * Absent means no host declared a supervisor; Ag receipts the launch
 * unsupervised. Present, it fences the model decision receipt: a receipt from
 * another generation says nothing about this instance.
 */
export const AG_HOST_LAUNCH_GENERATION_ENV = "AG_HOST_LAUNCH_GENERATION"

/**
 * Env names the host asks Ag to hand an MCP child as launch-time values, never
 * persisted into the child's config (a host-owned identity, for one). Ag
 * forwards what it is told and does not know what any name means.
 */
export const AG_HOST_MCP_FORWARD_ENV_KEYS_ENV = "AG_HOST_MCP_FORWARD_ENV_KEYS"

/**
 * The host's own command-line name, so Ag can point a user at a verb the host
 * owns without spelling the host. Absent means no host named one.
 */
export const AG_HOST_CLI_ENV = "AG_HOST_CLI"

export const AG_HOST_CONTROL_FD_ENV = "AG_HOST_CONTROL_FD"

export const AG_HOST_RESUME_TOKEN_ENV = "AG_HOST_RESUME_TOKEN"

/** Neutral host-projected identity shared by exit evidence and reload transport. */
export const AG_HOST_RUNTIME_KEY_ENV = "AG_HOST_RUNTIME_KEY"

/** Optional opaque host surface reference used only in diagnostic artifacts. */
export const AG_HOST_SURFACE_REF_ENV = "AG_HOST_SURFACE_REF"

/** Optional host-projected directory for durable per-session Ag state. */
export const AG_HOST_SESSION_STATE_DIR_ENV = "AG_HOST_SESSION_STATE_DIR"
