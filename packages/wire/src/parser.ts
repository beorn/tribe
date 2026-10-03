/**
 * Line-delimited JSON parser — accepts arbitrary chunk boundaries and emits
 * one message per complete `\n`-terminated JSON line. Incomplete trailing
 * lines are buffered until the next chunk completes them.
 */

import { createLogger } from "loggily"
import type { JsonRpcMessage } from "./rpc.ts"

const log = createLogger("tribe-client:parser")

export function createLineParser(
  onMessage: (msg: JsonRpcMessage) => void,
  // Optional seam for invalid lines. Always warned via loggily; `onInvalid` lets
  // callers (and tests) observe the bad input explicitly without depending on the
  // logger's sink wiring (see tribe-client parser.test.ts / km 19471).
  onInvalid?: (line: string, error: unknown) => void,
): (chunk: Buffer) => void {
  let fragments: Buffer[] = []
  let bufferedBytes = 0
  return (chunk: Buffer) => {
    let start = 0
    for (let end = chunk.indexOf(10, start); end !== -1; end = chunk.indexOf(10, start)) {
      const part = chunk.subarray(start, end)
      // Scan only new bytes; decode once the complete line is available. This
      // also preserves UTF-8 characters split across socket chunks.
      const line = fragments.length
        ? Buffer.concat([...fragments, part], bufferedBytes + part.length).toString()
        : part.toString()
      fragments = []
      bufferedBytes = 0
      start = end + 1
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        onMessage(JSON.parse(trimmed) as JsonRpcMessage)
      } catch (error) {
        log.warn?.(`Invalid JSON: ${trimmed.slice(0, 100)}`)
        onInvalid?.(trimmed, error)
      }
    }
    if (start < chunk.length) {
      const tail = Buffer.from(chunk.subarray(start))
      fragments.push(tail)
      bufferedBytes += tail.length
    }
  }
}
