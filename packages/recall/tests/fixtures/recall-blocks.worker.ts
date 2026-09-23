/**
 * A recall worker that never answers in time: it holds its thread for the query's number of milliseconds, then
 * answers with no results. `sqlite:<ms>` blocks inside one native SQLite call instead, the way a slow FTS query does
 * (@ag/tribe/25071 stopgap). Only the deadline tests load it.
 */
import { Database } from "bun:sqlite"

declare const self: Worker

self.onmessage = (event: MessageEvent<{ id: number; query: string }>) => {
  const { id, query } = event.data
  if (query.startsWith("sqlite:")) {
    // A recursive count that keeps SQLite busy in one native call for roughly the requested time.
    const rows = Number.parseInt(query.slice("sqlite:".length), 10) * 20_000
    new Database(":memory:")
      .query(
        `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ${String(rows)}) SELECT count(*) FROM c`,
      )
      .get()
  } else {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(query))
  }
  postMessage({ id, ok: true, result: { query, provenance: "unknown", synthesis: null, results: [], durationMs: 0 } })
}
