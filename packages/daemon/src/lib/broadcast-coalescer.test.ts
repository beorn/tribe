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

function build(opts: { batchMs: number; write: (connId: string, payload: string) => boolean }) {
  const singleEvent = (ev: PendingBroadcast) => `single:${ev.id}`
  const batched = (events: PendingBroadcast[], dropped: number) => `batched:${events.length}:${dropped}`
  const onDelivered = vi.fn()
  const timers: Array<() => void> = []
  const coalescer = createCoalescer({
    batchMs: opts.batchMs,
    maxEventsPerBatch: 50,
    deps: {
      singleEvent,
      batched,
      write: opts.write,
      onDelivered,
      setTimer: (fn) => {
        timers.push(fn)
        return timers.length
      },
      clearTimer: () => {},
    },
  })
  return { coalescer, onDelivered, timers }
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
