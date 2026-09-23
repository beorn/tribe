/**
 * A hard wall clock on the prompt hook's recall (@ag/tribe/25071 stopgap, @chief c348476a).
 *
 * Recall is synchronous SQLite, so no timer on the caller's thread can fire until it returns: measured on
 * 2026-09-23, the glossary fallback alone took over 25 s 28 times, and Claude Code's 30 s kill then discards the
 * whole hook output. Each call here runs in one Worker; when the deadline passes, the call rejects with
 * {@link RecallDeadlineError}, whose message is the loud line the hook prints, and the Worker is terminated.
 *
 * A Worker stuck inside one native SQLite call outlives terminate() until that call returns (measured: 48 s), and
 * keeps its process alive meanwhile. The deadline is real for the hook only because every hook path exits
 * explicitly. The 5 s is a stopgap figure, not the budget: 25071 row 2 sets that.
 */
import { IndexWriterBusyError } from "../history/db.ts"
import type { RecallOptions, RecallResult } from "../history/recall-shared.ts"
import type { recall } from "../history/search.ts"

export const RECALL_DEADLINE_MS = 5000

/** Recall outlived its deadline; the message is the line the hook says in its output. */
export class RecallDeadlineError extends Error {
  constructor(deadlineMs: number) {
    super(`recall skipped: over ${String(deadlineMs / 1000)} s (25071 stopgap)`)
    this.name = "RecallDeadlineError"
  }
}

export type DeadlineRecall = typeof recall & {
  /** Terminate the Worker. Safe to call more than once; later calls reject with the deadline's error. */
  close(): void
}

type WorkerAnswer =
  | { id: number; ok: true; result: RecallResult }
  | { id: number; ok: false; busy: boolean; message: string }

/**
 * `recall`, run in a Worker under ONE deadline shared by every call on it: the first query and the glossary fallback
 * together get `deadlineMs`, not each. The clock starts at the first call.
 */
export function createDeadlineRecall(opts: { deadlineMs?: number; workerUrl?: URL | string } = {}): DeadlineRecall {
  const deadlineMs = opts.deadlineMs ?? RECALL_DEADLINE_MS
  const workerUrl = opts.workerUrl ?? new URL("./recall-worker.ts", import.meta.url)
  const pending = new Map<number, { resolve: (result: RecallResult) => void; reject: (error: Error) => void }>()
  let worker: Worker | undefined
  let deadlineAt: number | undefined
  let expired = false
  let nextId = 0

  const close = (): void => {
    expired = true
    worker?.terminate()
    worker = undefined
  }

  const start = (): Worker => {
    const started = new Worker(workerUrl)
    started.onmessage = (event: MessageEvent<WorkerAnswer>) => {
      const answer = event.data
      const waiter = pending.get(answer.id)
      if (!waiter) return
      pending.delete(answer.id)
      if (answer.ok) waiter.resolve(answer.result)
      else if (answer.busy) waiter.reject(new IndexWriterBusyError(answer.message))
      else waiter.reject(new Error(`recall failed in its worker: ${answer.message}`))
    }
    started.onerror = (event: ErrorEvent) => {
      const error = new Error(`the recall worker failed: ${event.message}`)
      for (const waiter of pending.values()) waiter.reject(error)
      pending.clear()
    }
    return started
  }

  const call = (query: string, options: RecallOptions = {}): Promise<RecallResult> => {
    if (expired) return Promise.reject(new RecallDeadlineError(deadlineMs))
    worker ??= start()
    const deadline = (deadlineAt ??= Date.now() + deadlineMs)
    const id = nextId++
    const running = worker
    return new Promise<RecallResult>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          pending.delete(id)
          close()
          reject(new RecallDeadlineError(deadlineMs))
        },
        Math.max(0, deadline - Date.now()),
      )
      pending.set(id, {
        resolve: (result) => {
          clearTimeout(timer)
          resolve(result)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      running.postMessage({ id, query, options })
    })
  }

  return Object.assign(call, { close })
}

/** Whether `run` is a {@link createDeadlineRecall} recall, which owns a Worker its caller must close. */
export function isDeadlineRecall(run: unknown): run is DeadlineRecall {
  return typeof run === "function" && typeof (run as Partial<DeadlineRecall>).close === "function"
}
