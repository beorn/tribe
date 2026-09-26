import {
  TRIBE_NAME_ENV,
  TRIBE_PLUGIN_ADAPTER_CHILD_ENV,
  TRIBE_PLUGIN_ADAPTER_EXIT_RECORD_ENV,
  TRIBE_PLUGIN_PROVIDER_PARENT_PID_ENV,
  TRIBE_PLUGIN_REEXEC_EXIT_CODE_ENV,
  TRIBE_PLUGIN_RESUME_JOINED_ENV,
} from "tribe-wire/lib/session-identity-env"
/** Environment values owned by the stable Claude plugin supervisor. */

export const PLUGIN_REEXEC_EXIT_CODE = 75
export const PLUGIN_REEXEC_EXIT_CODE_ENV = TRIBE_PLUGIN_REEXEC_EXIT_CODE_ENV

const PLUGIN_ADAPTER_CHILD = TRIBE_PLUGIN_ADAPTER_CHILD_ENV
const PLUGIN_ADAPTER_EXIT_RECORD = TRIBE_PLUGIN_ADAPTER_EXIT_RECORD_ENV
const PLUGIN_PROVIDER_PARENT_PID = TRIBE_PLUGIN_PROVIDER_PARENT_PID_ENV
const PLUGIN_RESUME_JOINED = TRIBE_PLUGIN_RESUME_JOINED_ENV

export function buildPluginAdapterEnvironment(
  parentEnv: Readonly<NodeJS.ProcessEnv>,
  providerParentPid: number,
  resume?: { readonly name: string },
  exitRecordPath: string | null = null,
): NodeJS.ProcessEnv {
  return {
    ...parentEnv,
    [PLUGIN_ADAPTER_CHILD]: "1",
    // Only the supervisor that writes the record names it; an inherited value never passes through.
    [PLUGIN_ADAPTER_EXIT_RECORD]: exitRecordPath ?? undefined,
    [PLUGIN_PROVIDER_PARENT_PID]: String(providerParentPid),
    [PLUGIN_REEXEC_EXIT_CODE_ENV]: String(PLUGIN_REEXEC_EXIT_CODE),
    ...(resume ? { [PLUGIN_RESUME_JOINED]: "1", [TRIBE_NAME_ENV]: resume.name } : {}),
  }
}
