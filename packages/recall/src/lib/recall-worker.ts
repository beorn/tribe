/**
 * The Worker the prompt hook's recall runs in, so a deadline can leave it behind (@ag/tribe/25071 stopgap). Recall is
 * synchronous SQLite; on the hook's own thread no timer could fire until it returned. Answers `{ id, ok, result }`
 * or `{ id, ok: false, busy, message }`. Loaded only by recall-deadline.ts.
 */
import { setSuppressConsole } from "loggily"
import { IndexWriterBusyError } from "../history/db.ts"
import type { RecallOptions } from "../history/recall-shared.ts"
import { recall } from "../history/search.ts"

// Silence console sinks in the worker so recall logging never leaks to stderr (25392).
setSuppressConsole(true)

declare const self: Worker

self.onmessage = async (event: MessageEvent<{ id: number; query: string; options: RecallOptions }>) => {
  const { id, query, options } = event.data
  try {
    postMessage({ id, ok: true, result: await recall(query, options) })
  } catch (error) {
    postMessage({
      id,
      ok: false,
      busy: error instanceof IndexWriterBusyError,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}
