import { createHash } from "node:crypto"

/** The daemon's legacy message cap, mirrored client-side to fail before truncation. */
export const CLIENT_MESSAGE_MAX_LENGTH = 4096

// Keep sizing aligned with the daemon's sanitizer without importing daemon code
// into the reusable wire package.
// oxlint-disable-next-line no-control-regex -- mirrors the daemon boundary sanitizer.
const STRIPPED_CONTROL_CHARS = /[\u0000-\u0009\u000B-\u001F\u007F]/g

/** Return an actionable refusal, or null when the daemon will not truncate this message. */
export function oversizedMessageError(message: string): string | null {
  const sanitizedLength = message.replace(STRIPPED_CONTROL_CHARS, "").length
  if (sanitizedLength <= CLIENT_MESSAGE_MAX_LENGTH) return null

  const byteCount = Buffer.byteLength(message, "utf8")
  const sha256 = createHash("sha256").update(message, "utf8").digest("hex")
  return (
    `tribe.send rejected before daemon: message is ${byteCount} UTF-8 bytes (${message.length} UTF-16 code units), ` +
    `over the ${CLIENT_MESSAGE_MAX_LENGTH}-character cap. Save the exact content to a file and send a file+SHA pointer ` +
    `instead: file:///absolute/path/to/message sha256:${sha256}.`
  )
}
