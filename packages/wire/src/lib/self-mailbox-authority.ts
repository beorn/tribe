import { createHash } from "node:crypto"
import { fstatSync, readSync } from "node:fs"

export const TRIBE_SELF_MAILBOX_AUTHORITY_FD_ENV = "TRIBE_SELF_MAILBOX_AUTHORITY_FD"

const MAX_AUTHORITY_BYTES = 4_096

/**
 * Read a session's self-mailbox authority without changing the inherited open
 * file description's offset. The same descriptor can therefore be read by the
 * adapter, a CLI child, and a later replacement child in any order.
 */
export function readSelfMailboxAuthorityFromInheritedFd(env: Readonly<NodeJS.ProcessEnv>): string | null {
  const raw = env[TRIBE_SELF_MAILBOX_AUTHORITY_FD_ENV]
  if (raw === undefined) return null
  const fd = Number(raw)
  if (!Number.isSafeInteger(fd) || fd < 3) {
    throw new Error(
      `${TRIBE_SELF_MAILBOX_AUTHORITY_FD_ENV} must name an inherited fd >= 3, received ${JSON.stringify(raw)}`,
    )
  }
  const size = fstatSync(fd).size
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_AUTHORITY_BYTES) {
    throw new Error(
      `${TRIBE_SELF_MAILBOX_AUTHORITY_FD_ENV} must contain 1-${MAX_AUTHORITY_BYTES} bytes, received ${String(size)}`,
    )
  }
  const bytes = Buffer.alloc(size)
  const read = readSync(fd, bytes, 0, bytes.length, 0)
  const authority = bytes.subarray(0, read).toString("utf8").trim()
  if (!authority) throw new Error(`${TRIBE_SELF_MAILBOX_AUTHORITY_FD_ENV} contained an empty authority`)
  return authority
}

export function hashSelfMailboxAuthority(authority: string): string {
  return createHash("sha256").update(authority).digest("hex")
}
