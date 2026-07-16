import { createHash } from "node:crypto"

/**
 * Resolve the private runtime identity inherited by commands launched from the
 * current agent session. Unlike TRIBE_LAUNCH_ID, these values are not exposed
 * through Tribe's member/status projections.
 */
export function resolveRuntimeSessionIdentity(env: NodeJS.ProcessEnv = process.env): string | null {
  const claudeSessionId = env.CLAUDE_SESSION_ID?.trim()
  if (claudeSessionId) return claudeSessionId

  const codexThreadId = env.CODEX_THREAD_ID?.trim()
  if (codexThreadId) return codexThreadId

  return null
}

/** Stable proof shared by a managed adapter and commands from its runtime. */
export function createSessionIdentityToken(input: {
  runtimeSessionIdentity: string
  project: string
  role: string
}): string {
  return createHash("sha256").update(`${input.runtimeSessionIdentity}|${input.project}|${input.role}`).digest("hex")
}
