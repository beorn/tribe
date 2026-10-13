import { randomUUID } from "node:crypto"

import { isClosedConnectionError, isDaemonCallTimeoutError, type DaemonClient } from "../client.ts"
import { oversizedMessageError } from "./send-validation.ts"
import {
  DEFAULT_MCP_INBOX_WAIT_TIMEOUT_MS,
  deriveInboxWaitCallTimeoutMs,
  inboxWaitHostCutResult,
  MCP_INBOX_WAIT_HOST_CEILING_MS,
  parseInboxWaitResult,
  parseInboxWaitTimeoutMs,
  resolveInboxWaitControls,
} from "./inbox-wait-options.ts"

/** Bounded seam for the 28900 send retry; tests shrink both. */
export interface CallTribeToolOpts {
  readonly sendRetryDeadlineMs?: number
  readonly sendRetryDelayMs?: number
}

const SEND_RETRY_DEADLINE_MS = 8_000
const SEND_RETRY_DELAY_MS = 250

/**
 * 28900 (NO SILENT ERRORS): a tribe.send whose connection closes mid-send
 * must not vanish. Retry until the reconnect installs its successor, always
 * under ONE client message_id — minted here only when the caller omitted
 * one, so a caller-supplied blank or malformed id still reaches the daemon's
 * own invalid-id refusal — so a first write that did commit before the
 * socket died dedupes daemon-side instead of duplicating, and the returned
 * daemon result (id, deduplicated or fresh) is itself the read-back proof of
 * durable acceptance. The retry window is REAL elapsed time from the first
 * closed rejection: each retry carries the remaining time as its per-call
 * timeout and the delay is capped to what remains, so no attempt outlives
 * the bound (timeouts themselves stay non-retryable; one raised BY the bound
 * ends the window). Past the bound the truth is UNKNOWN acceptance — the
 * first write may have committed — so the thrown error says so and carries
 * the message_id for the caller's own deduping retry; both adapters surface
 * it as isError. Recipient lists never carry a message_id daemon-side, so
 * they keep the single-attempt path. The closed-connection predicate lives
 * in client.ts beside its throw sites (M2).
 */
async function callSendWithClosedConnectionRetry(
  client: DaemonClient,
  method: string,
  args: Record<string, unknown>,
  messageId: string,
  opts: CallTribeToolOpts,
): Promise<unknown> {
  const deadlineMs = opts.sendRetryDeadlineMs ?? SEND_RETRY_DEADLINE_MS
  const delayMs = opts.sendRetryDelayMs ?? SEND_RETRY_DELAY_MS
  let firstClosedAt: number | undefined
  let lastError: unknown
  for (;;) {
    const remainingMs = firstClosedAt === undefined ? undefined : deadlineMs - (Date.now() - firstClosedAt)
    if (remainingMs !== undefined && remainingMs <= 0) break
    try {
      return await client.call(method, args, remainingMs === undefined ? undefined : { timeoutMs: remainingMs })
    } catch (err) {
      // The bound's own per-call timeout ends the window; a timeout on the
      // first attempt propagates untouched, like every non-closed refusal.
      if (firstClosedAt !== undefined && isDaemonCallTimeoutError(err)) {
        lastError = err
        break
      }
      if (!isClosedConnectionError(err)) throw err
      lastError = err
      firstClosedAt ??= Date.now()
      const leftMs = deadlineMs - (Date.now() - firstClosedAt)
      if (leftMs <= 0) break
      await new Promise<void>((resolve) => {
        setTimeout(resolve, Math.min(delayMs, leftMs))
      })
    }
  }
  const reason = lastError instanceof Error ? lastError.message : String(lastError)
  throw new Error(
    `tribe.send not durably accepted within ${deadlineMs}ms of the closed connection: stop_reason=${reason}; ` +
      `it may have been written; retry under message_id ${messageId}`,
  )
}

/** Forward one MCP tool, refusing inbox waits that the host cannot preserve. */
export async function callTribeTool(
  client: DaemonClient,
  name: string,
  args: Record<string, unknown>,
  opts: CallTribeToolOpts = {},
): Promise<unknown> {
  const method = `tribe.${name}`
  if (name === "send" && typeof args.message === "string") {
    const error = oversizedMessageError(args.message)
    if (error !== null) {
      const structuredContent = { error }
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify(structuredContent) }],
        structuredContent,
      }
    }
  }
  if (name === "send" && !Array.isArray(args.to)) {
    // Mint only when omitted: a supplied blank/malformed id must reach the
    // daemon's own invalid-id refusal, never be silently normalized.
    const messageId = args.message_id === undefined ? randomUUID() : String(args.message_id)
    const withId = args.message_id === undefined ? { ...args, message_id: messageId } : args
    return callSendWithClosedConnectionRetry(client, method, withId, messageId, opts)
  }
  if (name !== "inbox.wait") return client.call(method, args)

  const requestedMs = parseInboxWaitTimeoutMs(args.timeout_ms ?? args.timeoutMs, DEFAULT_MCP_INBOX_WAIT_TIMEOUT_MS)
  if (requestedMs >= MCP_INBOX_WAIT_HOST_CEILING_MS) {
    const structuredContent = inboxWaitHostCutResult(requestedMs)
    return {
      content: [{ type: "text", text: JSON.stringify(structuredContent) }],
      structuredContent,
    }
  }

  const controls = resolveInboxWaitControls({ ...args, timeout_ms: requestedMs })
  const payload: Record<string, unknown> = {
    ...args,
    timeout_ms: controls.timeoutMs,
  }
  delete payload.timeoutMs
  delete payload.wake_on_correlated_reply
  delete payload.wakeOnCorrelatedReply
  if (controls.wakeOnCorrelatedReply) payload.wake_on_correlated_reply = true
  const result = await client.call(method, payload, { timeoutMs: deriveInboxWaitCallTimeoutMs(controls.timeoutMs) })
  const structuredContent = parseInboxWaitResult(result)
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
  }
}
