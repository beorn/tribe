/**
 * Test-only adapter entry for #28378 (failed channel notification recorded as a
 * completed delivery).
 *
 * It patches the MCP host transport so the FIRST channel notification whose
 * payload carries the FAULT marker rejects, then imports the real adapter
 * unchanged — every other send goes through the SDK's own implementation. This
 * is the injected-transport seam the reviewed reproduction used (see the bead's
 * native adapter reproduction); nothing in the adapter is reimplemented or
 * replaced by this file.
 *
 * Attempts are appended to $PROBE_FAULT_LOG as JSONL so a test can count the
 * real send attempts without reading the adapter's internals.
 */
import { appendFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ADAPTER = resolve(dirname(fileURLToPath(import.meta.url)), "../src/stdio-adapter.ts")
const sdkPath = Bun.resolveSync("@modelcontextprotocol/sdk/server/stdio.js", dirname(ADAPTER))
const { StdioServerTransport } = (await import(sdkPath)) as {
  StdioServerTransport: { prototype: { send: (message: unknown, ...rest: unknown[]) => Promise<void> } }
}

const sdkSend = StdioServerTransport.prototype.send
let rejected = false
StdioServerTransport.prototype.send = function (this: unknown, message: unknown, ...rest: unknown[]) {
  const asChannel =
    typeof message === "object" &&
    message !== null &&
    (message as { method?: string }).method === "notifications/claude/channel"
  if (asChannel && JSON.stringify(message).includes("FAULT-ROW")) {
    appendFileSync(
      process.env.PROBE_FAULT_LOG ?? "",
      `${JSON.stringify({ kind: "attempt", at: Date.now(), rejected })}\n`,
    )
    if (!rejected) {
      rejected = true
      return Promise.reject(new Error("TEST_FAULT_SEND_REJECTED"))
    }
  }
  return sdkSend.call(this, message, ...rest)
}

await import(ADAPTER)
