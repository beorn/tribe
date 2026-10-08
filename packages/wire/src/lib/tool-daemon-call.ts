import type { DaemonClient } from "../client.ts"
import { missingAskEchoError, parseAskEcho } from "./ask-echo.ts"
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

/** Forward one MCP tool, refusing inbox waits that the host cannot preserve. */
export async function callTribeTool(
  client: DaemonClient,
  name: string,
  args: Record<string, unknown>,
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
  if (name !== "inbox.wait") {
    const result = await client.call(method, args)
    if (name === "send") {
      const sentAsk = args.ask === undefined ? undefined : (parseAskEcho(args.ask) ?? { options: [] })
      const echoError = missingAskEchoError(sentAsk, unwrapToolJson(result))
      if (echoError !== null) {
        const structuredContent = { error: echoError }
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify(structuredContent) }],
          structuredContent,
        }
      }
    }
    return result
  }

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

function unwrapToolJson(result: unknown): unknown {
  if (typeof result !== "object" || result === null) return result
  const rec = result as Record<string, unknown>
  if (rec.structuredContent !== undefined) return rec.structuredContent
  const content = rec.content
  if (
    Array.isArray(content) &&
    content[0] !== null &&
    typeof content[0] === "object" &&
    typeof (content[0] as { text?: unknown }).text === "string"
  ) {
    try {
      return JSON.parse((content[0] as { text: string }).text) as unknown
    } catch {
      return result
    }
  }
  return result
}
