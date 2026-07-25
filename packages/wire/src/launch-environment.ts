/**
 * The process-boundary representation of Tribe's neutral `launchId`.
 *
 * Launchers and hosts pass a launch id structurally. Tribe alone owns how its
 * stdio adapter receives that value, so L1 consumers do not depend on an L2
 * environment-variable name.
 */

const LAUNCH_ID_ENV = "TRIBE_LAUNCH_ID"
const INHERITED_PARENT_PID_ENV = "TRIBE_LAUNCH_PARENT_PID"

export type TribeLaunchEnvironment = Readonly<Record<string, string | undefined>>

export function projectTribeLaunchEnvironment(launchId: string | undefined): Record<string, string> {
  const normalized = launchId?.trim()
  return normalized ? { [LAUNCH_ID_ENV]: normalized } : {}
}

export function readTribeLaunchId(env: TribeLaunchEnvironment): string | undefined {
  return env[LAUNCH_ID_ENV]?.trim() || undefined
}

export function tribeLaunchEnvironmentNames(): readonly string[] {
  return [LAUNCH_ID_ENV]
}

/**
 * Start one provider launch with fresh provenance.
 *
 * A nested launch must never inherit its caller's launch id or parent hint.
 * The supplied structural id replaces the first; the adapter recomputes the
 * real OS parent and ignores any inherited hint.
 */
export function withTribeLaunchEnvironment(env: NodeJS.ProcessEnv, launchId: string | undefined): NodeJS.ProcessEnv {
  return {
    ...env,
    [LAUNCH_ID_ENV]: undefined,
    ...projectTribeLaunchEnvironment(launchId),
    [INHERITED_PARENT_PID_ENV]: undefined,
  }
}
