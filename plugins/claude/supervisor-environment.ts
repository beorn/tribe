import {
  TRIBE_NAME_ENV,
  TRIBE_PLUGIN_ADAPTER_CHILD_ENV,
  TRIBE_PLUGIN_ADAPTER_EXIT_RECORD_ENV,
  TRIBE_PLUGIN_ANNOUNCED_DELIVERY_ENV,
  TRIBE_PLUGIN_PROVIDER_PARENT_PID_ENV,
  TRIBE_PLUGIN_REEXEC_EXIT_CODE_ENV,
  TRIBE_PLUGIN_PERSONA_REFUSAL_EXIT_CODE_ENV,
  TRIBE_PLUGIN_RESUME_JOINED_ENV,
} from "tribe-wire/lib/session-identity-env"
/** Environment values owned by the stable Claude plugin supervisor. */

export const PLUGIN_REEXEC_EXIT_CODE = 75
export const PLUGIN_PERSONA_REFUSAL_EXIT_CODE = 79
export const PLUGIN_REEXEC_EXIT_CODE_ENV = TRIBE_PLUGIN_REEXEC_EXIT_CODE_ENV

const PLUGIN_ADAPTER_CHILD = TRIBE_PLUGIN_ADAPTER_CHILD_ENV
const PLUGIN_ADAPTER_EXIT_RECORD = TRIBE_PLUGIN_ADAPTER_EXIT_RECORD_ENV
const PLUGIN_ANNOUNCED_DELIVERY = TRIBE_PLUGIN_ANNOUNCED_DELIVERY_ENV
const PLUGIN_PROVIDER_PARENT_PID = TRIBE_PLUGIN_PROVIDER_PARENT_PID_ENV
const PLUGIN_RESUME_JOINED = TRIBE_PLUGIN_RESUME_JOINED_ENV

/**
 * 28743 — the supervisor outlives every adapter child it spawns for one provider
 * session, so it is the only process whose memory of "this session already heard
 * banner S" has the right lifetime. It hands that memory back as
 * TRIBE_PLUGIN_ANNOUNCED_DELIVERY; the child still compares it against the mode
 * it acknowledged, so a changed mode announces as before.
 */
export function buildPluginAdapterEnvironment(
  parentEnv: Readonly<NodeJS.ProcessEnv>,
  providerParentPid: number,
  resume?: { readonly name: string },
  exitRecordPath: string | null = null,
  announcedDelivery?: string,
): NodeJS.ProcessEnv {
  return {
    ...parentEnv,
    [PLUGIN_ADAPTER_CHILD]: "1",
    // Only the supervisor that writes the record names it; an inherited value never passes through.
    [PLUGIN_ADAPTER_EXIT_RECORD]: exitRecordPath ?? undefined,
    // Same rule: only this supervisor's own memory of an announcement passes through.
    [PLUGIN_ANNOUNCED_DELIVERY]: announcedDelivery ?? undefined,
    [PLUGIN_PROVIDER_PARENT_PID]: String(providerParentPid),
    [PLUGIN_REEXEC_EXIT_CODE_ENV]: String(PLUGIN_REEXEC_EXIT_CODE),
    [TRIBE_PLUGIN_PERSONA_REFUSAL_EXIT_CODE_ENV]: String(PLUGIN_PERSONA_REFUSAL_EXIT_CODE),
    ...(resume ? { [PLUGIN_RESUME_JOINED]: "1", [TRIBE_NAME_ENV]: resume.name } : {}),
  }
}
