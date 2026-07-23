import type { DaemonClient } from "../client.ts"
import {
  deriveInboxWaitCallTimeoutMs,
  inboxWaitHostCutResult,
  MCP_INBOX_WAIT_HOST_CEILING_MS,
  parseInboxWaitResult,
  parseInboxWaitTimeoutMs,
  resolveInboxWaitControls,
} from "./inbox-wait-options.ts"

/** Forward one MCP tool to the daemon, preserving the full inbox-wait window. */
export async function callTribeTool(
  client: DaemonClient,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const method = `tribe.${name}`
  if (name !== "inbox.wait") return client.call(method, args)

  const requestedMs = parseInboxWaitTimeoutMs(args.timeout_ms ?? args.timeoutMs)
  if (requestedMs > MCP_INBOX_WAIT_HOST_CEILING_MS) {
    const structuredContent = inboxWaitHostCutResult(requestedMs)
    return {
      content: [{ type: "text", text: JSON.stringify(structuredContent) }],
      structuredContent,
    }
  }

  const controls = resolveInboxWaitControls(args)
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
