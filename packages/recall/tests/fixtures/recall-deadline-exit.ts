/**
 * A process that meets the recall deadline the way the prompt hook does: the query outlives the deadline inside one
 * native SQLite call, the deadline answers, and the process exits through the hook's own exit. It prints how long the
 * deadline took; the test times the whole process (@ag/tribe/25071 stopgap).
 */
import { createDeadlineRecall, RecallDeadlineError } from "../../src/lib/recall-deadline.ts"

const recall = createDeadlineRecall({
  deadlineMs: Number(process.argv[2] ?? 500),
  workerUrl: new URL("./recall-blocks.worker.ts", import.meta.url),
})
const started = performance.now()
try {
  await recall(`sqlite:${process.argv[3] ?? "20000"}`, {})
  console.log("answered")
} catch (error) {
  console.log(error instanceof RecallDeadlineError ? `deadline ${String(Math.round(performance.now() - started))}` : String(error))
}
process.exit(0)
