/**
 * @failure  a transient daemon-socket gap during cli_inbox_wait is retried by
 *           one consumer and ends another wait terminally, because the retry
 *           budget and the fail-loud boundary are re-implemented per caller
 *           instead of owned once at the tribe-wire transport layer
 * @level    l0 - pure classification + timing over an injected probe
 * @consumer @i/4-supervision/27416 (27397 Change 2)
 * @testonly none
 */
import { describe, expect, it } from "vitest"

import {
  INBOX_WAIT_TRANSPORT_BUDGET_MS,
  INBOX_WAIT_TRANSPORT_RETRY_MS,
  InboxWaitTransportError,
  withInboxWaitTransportRetry,
} from "../src/lib/inbox-wait-transport.ts"

function codedError(code: string): Error & { code: string } {
  const error = new Error(`connect ${code} /tmp/tribe.sock`) as Error & { code: string }
  error.code = code
  return error
}

describe("withInboxWaitTransportRetry", () => {
  it("retries a classified transport gap, declares it, and returns the probe's value", async () => {
    const gaps: Array<[string, number]> = []
    const sleeps: number[] = []
    let clock = 0
    let calls = 0
    const value = await withInboxWaitTransportRetry(
      async () => {
        calls += 1
        if (calls === 1) throw codedError("ECONNRESET")
        return "attention"
      },
      {
        now: () => clock,
        sleep: async (ms) => {
          sleeps.push(ms)
          clock += ms
        },
        onGap: (kind, attempt) => gaps.push([kind, attempt]),
      },
    )

    expect(value).toBe("attention")
    expect(calls).toBe(2)
    expect(gaps).toEqual([["transport-close", 1]])
    expect(sleeps).toEqual([INBOX_WAIT_TRANSPORT_RETRY_MS])
  })

  it("surfaces a non-classified failure immediately, with no retry and no gap row", async () => {
    const gaps: unknown[] = []
    let calls = 0
    await expect(
      withInboxWaitTransportRetry(
        async () => {
          calls += 1
          throw new Error("daemon unreachable")
        },
        { onGap: (kind) => gaps.push(kind) },
      ),
    ).rejects.toThrow("daemon unreachable")

    expect(calls).toBe(1)
    expect(gaps).toEqual([])
  })

  it("throws a named InboxWaitTransportError once a classified gap outlives the declared budget", async () => {
    const budgetMs = INBOX_WAIT_TRANSPORT_RETRY_MS * 3
    const gaps: string[] = []
    let clock = 0
    let calls = 0

    let thrown: unknown
    try {
      await withInboxWaitTransportRetry(
        async () => {
          calls += 1
          throw codedError("ENOENT")
        },
        {
          budgetMs,
          now: () => clock,
          sleep: async (ms) => {
            clock += ms
          },
          onGap: (kind) => gaps.push(kind),
        },
      )
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(InboxWaitTransportError)
    expect((thrown as InboxWaitTransportError).kind).toBe("daemon-unavailable")
    expect((thrown as InboxWaitTransportError).attempts).toBeGreaterThan(1)
    expect(calls).toBeGreaterThan(1)
    expect(gaps.every((kind) => kind === "daemon-unavailable")).toBe(true)
    expect(gaps.length).toBe(calls)
  })

  it("declares the shared bound and retry delay", () => {
    expect(INBOX_WAIT_TRANSPORT_BUDGET_MS).toBe(30_000)
    expect(INBOX_WAIT_TRANSPORT_RETRY_MS).toBe(250)
  })
})
