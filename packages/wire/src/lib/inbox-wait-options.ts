export const DEFAULT_INBOX_WAIT_SESSION = "@chief"
export const DEFAULT_INBOX_WAIT_TIMEOUT_MS = 30_000
export const MAX_INBOX_WAIT_TIMEOUT_MS = 30 * 60_000

const MIN_INBOX_WAIT_CALL_TIMEOUT_MS = 10_000
const INBOX_WAIT_CALL_TIMEOUT_MARGIN_MS = 5_000

export type InboxWaitOptionSource = {
  readonly session?: unknown
  readonly timeout_ms?: unknown
  readonly timeoutMs?: unknown
  readonly wake_on_correlated_reply?: unknown
  readonly wakeOnCorrelatedReply?: unknown
}

export type InboxWaitControls = {
  readonly timeoutMs: number
  readonly wakeOnCorrelatedReply: boolean
}

export type InboxWaitOptions = InboxWaitControls & {
  readonly session: string
}

export type InboxWaitAttention = {
  readonly actionable_unread: readonly Record<string, unknown>[]
  readonly pending_balls: readonly Record<string, unknown>[]
  readonly pending_balls_summary: {
    readonly total: number
    readonly oldest_age_ms: number
  }
}

export type InboxWaitResult = {
  readonly session: string
  readonly unread_count: number
  readonly oldest_unread_age_min: number
  readonly oldest_unread_ts: number
  readonly waited_ms: number
  readonly effective_timeout_ms: number
  readonly timed_out: boolean
  readonly aborted: boolean
  readonly attention: InboxWaitAttention
}

export function parseInboxWaitTimeoutMs(raw: unknown, fallback = DEFAULT_INBOX_WAIT_TIMEOUT_MS): number {
  const timeoutMs = Number(raw)
  return Number.isFinite(timeoutMs) ? timeoutMs : fallback
}

export function resolveInboxWaitControls(source: InboxWaitOptionSource): InboxWaitControls {
  const timeoutRaw = source.timeout_ms ?? source.timeoutMs
  return {
    timeoutMs: Math.min(MAX_INBOX_WAIT_TIMEOUT_MS, Math.max(0, parseInboxWaitTimeoutMs(timeoutRaw))),
    wakeOnCorrelatedReply: source.wake_on_correlated_reply === true || source.wakeOnCorrelatedReply === true,
  }
}

export function deriveInboxWaitCallTimeoutMs(effectiveTimeoutMs: number): number {
  const boundedTimeoutMs = Math.min(MAX_INBOX_WAIT_TIMEOUT_MS, Math.max(0, parseInboxWaitTimeoutMs(effectiveTimeoutMs)))
  return Math.max(MIN_INBOX_WAIT_CALL_TIMEOUT_MS, boundedTimeoutMs + INBOX_WAIT_CALL_TIMEOUT_MARGIN_MS)
}

export function parseInboxWaitResult(value: unknown): InboxWaitResult {
  if (!isRecord(value)) throw invalidInboxWaitResult()
  const attention = value.attention
  if (
    typeof value.session !== "string" ||
    !isFiniteNumber(value.unread_count) ||
    !isFiniteNumber(value.oldest_unread_age_min) ||
    !isFiniteNumber(value.oldest_unread_ts) ||
    !isFiniteNumber(value.waited_ms) ||
    !isFiniteNumber(value.effective_timeout_ms) ||
    typeof value.timed_out !== "boolean" ||
    typeof value.aborted !== "boolean" ||
    !isRecord(attention) ||
    !isRecordArray(attention.actionable_unread) ||
    !isRecordArray(attention.pending_balls) ||
    !isRecord(attention.pending_balls_summary) ||
    !isFiniteNumber(attention.pending_balls_summary.total) ||
    !isFiniteNumber(attention.pending_balls_summary.oldest_age_ms)
  ) {
    throw invalidInboxWaitResult()
  }
  return {
    session: value.session,
    unread_count: value.unread_count,
    oldest_unread_age_min: value.oldest_unread_age_min,
    oldest_unread_ts: value.oldest_unread_ts,
    waited_ms: value.waited_ms,
    effective_timeout_ms: value.effective_timeout_ms,
    timed_out: value.timed_out,
    aborted: value.aborted,
    attention: {
      actionable_unread: attention.actionable_unread,
      pending_balls: attention.pending_balls,
      pending_balls_summary: {
        total: attention.pending_balls_summary.total,
        oldest_age_ms: attention.pending_balls_summary.oldest_age_ms,
      },
    },
  }
}

export function resolveInboxWaitOptions(
  source: InboxWaitOptionSource,
  opts: { readonly defaultSession?: string } = {},
): InboxWaitOptions {
  const session = typeof source.session === "string" && source.session.length > 0 ? source.session : opts.defaultSession
  return {
    session: session ?? DEFAULT_INBOX_WAIT_SESSION,
    ...resolveInboxWaitControls(source),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isRecordArray(value: unknown): value is readonly Record<string, unknown>[] {
  return Array.isArray(value) && value.every(isRecord)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function invalidInboxWaitResult(): Error {
  return new Error("tribe.inbox.wait returned an invalid canonical InboxWaitResult")
}
