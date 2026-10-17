/**
 * The type prefix a pane reads as "no reply owed" (#28378, #29327).
 *
 * The marker is carried on the envelope's TYPE, not its content: content is
 * the sender's words (and `tryAutoRenameOnClaim` parses it), while the type is
 * the attribute a pane renders and the seat instructions bind.
 */
export const NOTIFICATION_ONLY_MARKER = "notification-only:do-not-acknowledge-or-respond-to"

export function isNotificationOnlyType(type: string): boolean {
  if (type === "session" || type === "status" || type === "delta") return true
  if (type.startsWith("chief:")) return true
  if (type.startsWith("github:")) return true
  return false
}

/**
 * 29327 — a settled ball is not owed work. Its row keeps the sender's type
 * (`request`, `query`, `assign`), so the type alone would still read as
 * actionable; the settled flag puts it behind the same marker every ambient
 * row uses, rather than inventing a second "not actionable" mechanism.
 */
export function markedType(type: string, settled?: boolean): string {
  if (settled === true) return `${NOTIFICATION_ONLY_MARKER}:${type}`
  return isNotificationOnlyType(type) ? `${NOTIFICATION_ONLY_MARKER}:${type}` : type
}
