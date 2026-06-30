export const DEFAULT_INBOX_WAIT_SESSION = "@chief"
export const DEFAULT_INBOX_WAIT_TIMEOUT_MS = 30_000

export type InboxWaitOptionSource = {
  readonly session?: unknown
  readonly timeout_ms?: unknown
  readonly timeoutMs?: unknown
}

export type InboxWaitOptions = {
  readonly session: string
  readonly timeoutMs: number
}

export function parseInboxWaitTimeoutMs(raw: unknown, fallback = DEFAULT_INBOX_WAIT_TIMEOUT_MS): number {
  const timeoutMs = Number(raw)
  return Number.isFinite(timeoutMs) ? timeoutMs : fallback
}

export function resolveInboxWaitOptions(
  source: InboxWaitOptionSource,
  opts: { readonly defaultSession?: string } = {},
): InboxWaitOptions {
  const session = typeof source.session === "string" && source.session.length > 0 ? source.session : opts.defaultSession
  const timeoutRaw = source.timeout_ms ?? source.timeoutMs
  return {
    session: session ?? DEFAULT_INBOX_WAIT_SESSION,
    timeoutMs: parseInboxWaitTimeoutMs(timeoutRaw),
  }
}
