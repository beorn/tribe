import { createHash } from "node:crypto"

export const AG_SESSION_AUTH_ENV = "AG_SESSION_AUTH"

const SESSION_AUTH_PATTERN = /^[A-Za-z0-9_-]{43}$/u

/**
 * Read the launcher's per-session bearer from the one carrier unmodified
 * provider binaries propagate to ordinary children. The daemon binds only its
 * hash to one mailbox; the raw value never enters argv, logs, or durable plans.
 */
export function readSelfMailboxAuthorityFromEnvironment(env: Readonly<NodeJS.ProcessEnv>): string | null {
  const raw = env[AG_SESSION_AUTH_ENV]
  if (raw === undefined) return null
  if (!SESSION_AUTH_PATTERN.test(raw)) throw new Error(`${AG_SESSION_AUTH_ENV} must be a 32-byte base64url bearer`)
  return raw
}

export function hashSelfMailboxAuthority(authority: string): string {
  return createHash("sha256").update(authority).digest("hex")
}
