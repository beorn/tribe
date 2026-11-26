/**
 * @failure A queued flush whose write did not happen still advances
 * sessions.last_delivered_seq, so the ledger calls a row written when nothing
 * reached a socket.
 * @level l2
 * @consumer withBroadcast's queued fanout and the delivery cursor
 * @testonly none
 *
 * The delivery cursor is a high-water mark over "bytes accepted by a writable
 * socket", so a write that did not happen must never move it. The wrapper in
 * with-broadcast turns a dead/absent/non-push client into `write() === false`
 * and catches socket throws, so these cases are the whole failure surface the
 * coalescer can see (@cto ruling on 33302: pin the property, do not add state).
 */
import { describe, expect, it, vi } from "vitest"

import { createCoalescer, type PendingBroadcast } from "./broadcast-coalescer.ts"

function event(id: string, rowid: number): PendingBroadcast {
  return {
    id,
    ts: rowid,
    rowid,
    type: "notify",
    sender: "@chief",
    content: id,
    bead_id: null,
    replyHint: "no",
    topic: null,
  }
}

function build(opts: {
  batchMs: number
  write: (connId: string, payload: string) => boolean
  maxEventsPerBatch?: number
}) {
  const singleEvent = (ev: PendingBroadcast) => `single:${ev.id}`
  const batched = (events: PendingBroadcast[], dropped: number) => `batched:${events.length}:${dropped}`
  const onDelivered = vi.fn()
  const onWriteFailed = vi.fn()
  const timers: Array<() => void> = []
  const coalescer = createCoalescer({
    batchMs: opts.batchMs,
    maxEventsPerBatch: opts.maxEventsPerBatch ?? 50,
    deps: {
      singleEvent,
      batched,
      write: opts.write,
      onDelivered,
      onWriteFailed,
      setTimer: (fn) => {
        timers.push(fn)
        return timers.length
      },
      clearTimer: () => {},
    },
  })
  return { coalescer, onDelivered, onWriteFailed, timers }
}

describe("broadcast-coalescer delivery cursor", () => {
  // @failure A queued flush whose write fails still calls onDelivered, so the
  // session cursor records a row nobody wrote to a socket.
  // @level l2 @consumer withBroadcast's queued fanout and sessions.last_delivered_seq
  it("does not advance the cursor when the queued write returns false", () => {
    const { coalescer, onDelivered } = build({ batchMs: 400, write: () => false })

    coalescer.enqueue("conn", event("a", 7))
    coalescer.enqueue("conn", event("b", 8))
    coalescer.flush("conn")

    expect(onDelivered).not.toHaveBeenCalled()
  })

  it("advances the cursor once per kept event when the queued write succeeds", () => {
    const { coalescer, onDelivered } = build({ batchMs: 400, write: () => true })

    coalescer.enqueue("conn", event("a", 7))
    coalescer.enqueue("conn", event("b", 8))
    coalescer.flush("conn")

    expect(onDelivered.mock.calls.map((call) => call[1].id)).toEqual(["a", "b"])
  })

  it("does not advance the cursor when batching is off and the write returns false", () => {
    const { coalescer, onDelivered } = build({ batchMs: 0, write: () => false })

    coalescer.enqueue("conn", event("a", 7))

    expect(onDelivered).not.toHaveBeenCalled()
  })

  it("writes through and advances when batching is off and the write succeeds", () => {
    const { coalescer, onDelivered } = build({ batchMs: 0, write: () => true })

    coalescer.enqueue("conn", event("a", 7))

    expect(onDelivered.mock.calls.map((call) => call[1].id)).toEqual(["a"])
  })
})

describe("broadcast-coalescer: a failed write never loses the wake (#38676)", () => {
  // @failure The queue was emptied before the write and its timer cleared, so one failed
  //   socket write discarded the daemon's own copy with nothing retrying and no line saying
  //   so: the row then read "never written to its socket" until a process restart.
  // @level l2 @consumer withBroadcast's queued fanout and sessions.last_delivered_seq
  it("keeps the events queued and arms a retry when the write returns false", () => {
    const attemptResults = [false, true]
    const { coalescer, onDelivered, timers, onWriteFailed } = build({
      batchMs: 400,
      write: () => attemptResults.shift() ?? true,
    })

    coalescer.enqueue("conn", event("a", 7))
    coalescer.enqueue("conn", event("b", 8))
    coalescer.flush("conn")

    expect(onDelivered).not.toHaveBeenCalled()
    expect(coalescer.pendingCount("conn")).toBe(2)
    expect(onWriteFailed).toHaveBeenCalledTimes(1)
    expect(onWriteFailed.mock.calls[0]![2]).toBe(1)
    // The retry the coalescer armed itself, not a caller's flush.
    expect(timers.length).toBeGreaterThan(0)
    timers.at(-1)!()

    expect(onDelivered.mock.calls.map((call) => call[1].id)).toEqual(["a", "b"])
    expect(coalescer.pendingCount("conn")).toBe(0)
  })

  it("keeps a failed event when batching is off, so its cursor is never advanced", () => {
    const { coalescer, onDelivered, onWriteFailed } = build({ batchMs: 0, write: () => false })

    coalescer.enqueue("conn", event("a", 7))

    expect(onDelivered).not.toHaveBeenCalled()
    expect(coalescer.pendingCount("conn")).toBe(1)
    expect(onWriteFailed).toHaveBeenCalledTimes(1)
  })

  it("advances the cursor for every event the payload accounted for, past the per-batch cap too", () => {
    const { coalescer, onDelivered } = build({ batchMs: 400, write: () => true, maxEventsPerBatch: 2 })

    for (const [index, id] of ["a", "b", "c", "d"].entries()) coalescer.enqueue("conn", event(id, 7 + index))
    coalescer.flush("conn")

    // Two events were written with a "+N more" marker; all four are covered by that write, so all four cursors move.
    expect(onDelivered.mock.calls.map((call) => call[1].id)).toEqual(["a", "b", "c", "d"])
  })
})
