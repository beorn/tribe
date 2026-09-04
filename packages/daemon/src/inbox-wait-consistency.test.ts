import { describe, expect, it } from "vitest"
import { createInboxWaitManager, type InboxStatus } from "./lib/inbox-wait.ts"

/**
 * A wait payload must never contradict itself.
 *
 * `unread_count` and `attention.actionable_unread` come from two independent
 * reads, and nothing used to make them agree — so a payload could report
 * unread_count: 0 while handing the caller a non-empty actionable_unread. A seat
 * reads the count, concludes nothing arrived, and sleeps on top of work it was
 * just given.
 *
 * Measured on a live seat: four consecutive timeouts each said unread_count=0
 * while replaying the same two actionable rows.
 */

function status(session: string, unread: number): InboxStatus {
  return {
    session,
    unread_count: unread,
    oldest_unread_age_min: unread > 0 ? 2 : 0,
    oldest_unread_ts: unread > 0 ? Date.now() - 120_000 : 0,
  }
}

function attentionWith(rowCount: number) {
  return {
    actionable_unread: Array.from({ length: rowCount }, (_, i) => ({ id: `row-${i}` })) as never,
    pending_balls: [],
    pending_balls_summary: { total: 0, oldest_age_ms: 0, truncated: false },
  }
}

/** Settles immediately on the timeout edge, which is the state that carried the lie. */
async function waitOnce(statusUnread: number, attentionRows: number) {
  const manager = createInboxWaitManager(
    (session) => status(session, statusUnread),
    () => attentionWith(attentionRows),
  )
  return manager.wait("@seat", "conn-1", 1, { wakeOnCorrelatedReply: false })
}

describe("inbox wait payload self-consistency", () => {
  it("reports the rows it is handing over, not the stale independent count", async () => {
    // The exact contradiction measured in the field: the status projection lags
    // at zero while two actionable rows are carried.
    const result = await waitOnce(0, 2)

    expect(result.attention.actionable_unread).toHaveLength(2)
    expect(result.unread_count).toBe(2)
  })

  it("does not report rows that the canonical attention projection cannot hand over", async () => {
    // A scalar is not a second queue. If the list is empty, the payload must not
    // claim that three actionable rows exist somewhere else.
    const result = await waitOnce(3, 0)

    expect(result.attention.actionable_unread).toHaveLength(0)
    expect(result.unread_count).toBe(0)
  })

  it("always derives the scalar from the rows in the same payload", async () => {
    for (const [statusUnread, rows] of [
      [0, 2],
      [3, 0],
      [2, 2],
      [0, 0],
      [1, 9],
    ] as const) {
      const result = await waitOnce(statusUnread, rows)
      expect(result.unread_count).toBe(rows)
    }
  })

  it("keeps the count and the rows agreeing on a timeout, where they diverged", async () => {
    const result = await waitOnce(0, 1)

    expect(result.timed_out).toBe(true)
    expect(result.status).toBe("timeout")
    // A timeout may legitimately carry work — rows already present when the timer
    // fired never triggered an insert-wake. What it may NOT do is deny them.
    expect(result.unread_count).toBe(result.attention.actionable_unread.length)
  })
})
