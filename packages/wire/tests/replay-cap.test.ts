// Tests the connection-time drain replay cap — km @km/tribe/19442.
//
// The adapter's drainDaemonInbox used to forward EVERY drained event as a
// <channel> envelope (tribe.fetch limit:500 looped until empty), flooding agent
// context on connect. selectReplayEvents is the pure policy that bounds what gets
// surfaced: max 100 events, drop anything older than 1 day. This is the real
// drain-path test (the policy), complementing the instruction-string grep guard.
import { describe, expect, it } from "vitest"
import {
  CONNECT_REPLAY_WINDOW_MS,
  createConnectReplayGate,
  createForwardedAttentionTracker,
  decidePendingBallSummary,
  MAX_REPLAY_AGE_MS,
  MAX_REPLAY_EVENTS,
  PENDING_BALL_SUMMARY_WINDOW_MS,
  replayEnvelopeMeta,
  selectReplayEvents,
} from "../src/lib/replay-cap.ts"

// Fixed clock — no Date.now() so the test is deterministic.
const NOW = Date.UTC(2026, 4, 30, 12, 0, 0)
const isoAgo = (msAgo: number) => new Date(NOW - msAgo).toISOString()

describe("selectReplayEvents (km 19442 connection-time replay cap)", () => {
  it("forwards recent events untouched when under both caps", () => {
    const events = [
      { id: "a", ts: isoAgo(1_000) },
      { id: "b", ts: isoAgo(2_000) },
    ]
    const r = selectReplayEvents(events, { now: NOW })
    expect(r.forward.map((e) => e.id)).toEqual(["a", "b"])
    expect(r.skippedOld).toBe(0)
    expect(r.capped).toBe(0)
  })

  it("drops events older than the age cap (default 1 day)", () => {
    const events = [
      { id: "fresh", ts: isoAgo(0) },
      { id: "stale", ts: isoAgo(MAX_REPLAY_AGE_MS + 60_000) }, // > 1d old
      { id: "just-in", ts: isoAgo(MAX_REPLAY_AGE_MS - 60_000) }, // < 1d old
    ]
    const r = selectReplayEvents(events, { now: NOW })
    expect(r.forward.map((e) => e.id)).toEqual(["fresh", "just-in"])
    expect(r.skippedOld).toBe(1)
    expect(r.capped).toBe(0)
  })

  it("keeps an event sitting exactly on the age cutoff (older-than is strict)", () => {
    const events = [{ id: "edge", ts: isoAgo(MAX_REPLAY_AGE_MS) }]
    const r = selectReplayEvents(events, { now: NOW })
    expect(r.forward.map((e) => e.id)).toEqual(["edge"])
    expect(r.skippedOld).toBe(0)
  })

  it("caps the number of surfaced events", () => {
    const events = Array.from({ length: MAX_REPLAY_EVENTS + 50 }, (_, i) => ({ id: String(i), ts: isoAgo(i) }))
    const r = selectReplayEvents(events, { now: NOW })
    expect(r.forward).toHaveLength(MAX_REPLAY_EVENTS)
    expect(r.capped).toBe(50)
    expect(r.skippedOld).toBe(0)
  })

  it("fails open on missing/unparseable ts — keeps the event rather than dropping it", () => {
    const events = [{ id: "no-ts" }, { id: "bad-ts", ts: "not-a-date" }]
    const r = selectReplayEvents(events, { now: NOW })
    expect(r.forward.map((e) => e.id)).toEqual(["no-ts", "bad-ts"])
    expect(r.skippedOld).toBe(0)
  })

  it("surfaces nothing for a huge all-stale backlog (the connection-flood case)", () => {
    // all strictly older than 1d (+1min so none sit exactly on the cutoff)
    const events = Array.from({ length: 500 }, (_, i) => ({
      id: String(i),
      ts: isoAgo(MAX_REPLAY_AGE_MS + 60_000 + i * 1_000),
    }))
    const r = selectReplayEvents(events, { now: NOW })
    expect(r.forward).toHaveLength(0)
    expect(r.skippedOld).toBe(500)
  })

  it("honours explicit overrides for caps", () => {
    const events = Array.from({ length: 10 }, (_, i) => ({ id: String(i), ts: isoAgo(i) }))
    const r = selectReplayEvents(events, { now: NOW, maxEvents: 3, maxAgeMs: 60_000 })
    expect(r.forward).toHaveLength(3)
    expect(r.capped).toBe(7)
  })
})

// The OTHER flood path (km 19442 reopen): a stale daemon that still pushes message
// BODIES as `channel` notifications bypasses the drain cap above. createConnectReplayGate
// bounds that per-(re)connect burst. Deterministic — `now` is passed, never read.
describe("createConnectReplayGate (km 19442 channel-push connect-burst cap)", () => {
  const T0 = 1_000_000

  it("forwards freely before any connect (steady state from start)", () => {
    const gate = createConnectReplayGate({ maxEvents: 3 })
    for (let i = 0; i < 50; i++) expect(gate.admit(T0 + i)).toBe(true)
    expect(gate.dropped).toBe(0)
  })

  it("bounds the post-connect burst to maxEvents, dropping the rest", () => {
    const gate = createConnectReplayGate({ maxEvents: 3, windowMs: 5_000 })
    gate.reset(T0)
    const verdicts = Array.from({ length: 10 }, (_, i) => gate.admit(T0 + i)) // all within window
    expect(verdicts.filter(Boolean)).toHaveLength(3)
    expect(gate.dropped).toBe(7)
  })

  it("forwards freely again once the window elapses (live messages are never withheld)", () => {
    const gate = createConnectReplayGate({ maxEvents: 2, windowMs: 5_000 })
    gate.reset(T0)
    expect(gate.admit(T0)).toBe(true)
    expect(gate.admit(T0 + 1)).toBe(true)
    expect(gate.admit(T0 + 2)).toBe(false) // over cap, still in window
    expect(gate.admit(T0 + 5_000)).toBe(true) // window elapsed → steady state
    expect(gate.admit(T0 + 6_000)).toBe(true)
  })

  it("reset reopens the window so a reconnect burst is rebounded", () => {
    const gate = createConnectReplayGate({ maxEvents: 2, windowMs: 5_000 })
    gate.reset(T0)
    gate.admit(T0)
    gate.admit(T0 + 1)
    gate.admit(T0 + 2) // 2 forwarded, 1 dropped
    expect(gate.dropped).toBe(1)
    gate.reset(T0 + 100_000) // reconnect much later
    expect(gate.dropped).toBe(0) // counters reset
    expect(gate.admit(T0 + 100_000)).toBe(true)
    expect(gate.admit(T0 + 100_001)).toBe(true)
    expect(gate.admit(T0 + 100_002)).toBe(false)
    expect(gate.dropped).toBe(1)
  })

  it("defaults to MAX_REPLAY_EVENTS over the connect window", () => {
    const gate = createConnectReplayGate()
    gate.reset(T0)
    const verdicts = Array.from({ length: MAX_REPLAY_EVENTS + 25 }, (_, i) => gate.admit(T0 + i))
    expect(verdicts.filter(Boolean)).toHaveLength(MAX_REPLAY_EVENTS)
    expect(gate.dropped).toBe(25)
    expect(gate.admit(T0 + CONNECT_REPLAY_WINDOW_MS)).toBe(true) // past window → steady state
  })
})

// 27346 - the tracked branch of the daemon's selectAttention re-presents an
// untaken ball past the mailbox cursor on purpose (22203). A pane that drains
// the envelope hours later must be told when the row was FIRST sent, or it
// reads the old row as a fresh instruction. A re-presented row also names
// itself a replay. The FIRST (fresh) envelope carries the same first-sent time:
// it is built once and cannot be revised when the ball later settles, so an
// envelope already queued in the host must still be readable as old.
describe("replayEnvelopeMeta (27346 re-presented attention row)", () => {
  it("names a re-presented row a replay and carries its original send time", () => {
    expect(replayEnvelopeMeta({ replay: true, ts: "2026-10-04T06:00:00.000Z" })).toEqual({
      replay: "true",
      sent_at: "2026-10-04T06:00:00.000Z",
    })
  })

  it("carries the first-sent time on a fresh row too, so a queued envelope is never read as new", () => {
    expect(replayEnvelopeMeta({ replay: false, ts: "2026-10-04T06:00:00.000Z" })).toEqual({
      sent_at: "2026-10-04T06:00:00.000Z",
    })
    expect(replayEnvelopeMeta({ ts: "2026-10-04T06:00:00.000Z" })).toEqual({
      sent_at: "2026-10-04T06:00:00.000Z",
    })
    // Fail open on a missing timestamp: a row we cannot age carries no claim.
    expect(replayEnvelopeMeta({ replay: false })).toEqual({})
  })

  it("still names the replay when the row carries no timestamp", () => {
    expect(replayEnvelopeMeta({ replay: true })).toEqual({ replay: "true" })
  })
})

// 27346 — each wakeup drain re-forwarded the open-ball summary line, so a push
// seat's pane repeated "You own N balls ..." on every arrival. decidePendingBallSummary
// is the pure in-memory throttle: the line is re-surfaced only when the ball set
// changed or the window elapsed. `now` is passed, never read — deterministic.
describe("decidePendingBallSummary (27346 open-ball summary throttle)", () => {
  const NOW = 1_000_000
  const ball = (request_id: string) => ({ request_id })

  it("sends the first nonempty set and records its fingerprint", () => {
    const r = decidePendingBallSummary(
      { balls: [ball("r1"), ball("r2")], summary: { total: 2 } },
      { now: NOW, state: null },
    )
    expect(r.send).toBe(true)
    expect(r.state).toMatchObject({ previewIds: "r1,r2", total: 2, withheld: 0, sentAt: NOW })
  })

  it("suppresses an unchanged immediate re-drain, keeping the original sentAt", () => {
    const first = decidePendingBallSummary({ balls: [ball("r1")], summary: { total: 1 } }, { now: NOW, state: null })
    const second = decidePendingBallSummary(
      { balls: [ball("r1")], summary: { total: 1 } },
      { now: NOW + 60_000, state: first.state },
    )
    expect(second.send).toBe(false)
    expect(second.state).toEqual(first.state)
  })

  it("ignores a changing age and only re-surfaces once the window elapses", () => {
    const first = decidePendingBallSummary(
      { balls: [ball("r1")], summary: { total: 1, oldest_age_ms: 1_000 } },
      { now: NOW, state: null },
    )
    const justBefore = decidePendingBallSummary(
      { balls: [ball("r1")], summary: { total: 1, oldest_age_ms: 999_000 } },
      { now: NOW + PENDING_BALL_SUMMARY_WINDOW_MS - 1, state: first.state },
    )
    expect(justBefore.send).toBe(false)
    const atWindow = decidePendingBallSummary(
      { balls: [ball("r1")], summary: { total: 1, oldest_age_ms: 999_999 } },
      { now: NOW + PENDING_BALL_SUMMARY_WINDOW_MS, state: first.state },
    )
    expect(atWindow.send).toBe(true)
    expect(atWindow.state?.sentAt).toBe(NOW + PENDING_BALL_SUMMARY_WINDOW_MS)
  })

  it("re-surfaces when the preview request_id set changes", () => {
    const first = decidePendingBallSummary({ balls: [ball("r1")], summary: { total: 1 } }, { now: NOW, state: null })
    const changed = decidePendingBallSummary(
      { balls: [ball("r1"), ball("r2")], summary: { total: 2 } },
      { now: NOW + 1, state: first.state },
    )
    expect(changed.send).toBe(true)
    expect(changed.state?.previewIds).toBe("r1,r2")
  })

  it("re-surfaces when the total changes even though the preview is unchanged", () => {
    const first = decidePendingBallSummary(
      { balls: [ball("r1"), ball("r2")], summary: { total: 2 } },
      { now: NOW, state: null },
    )
    const grown = decidePendingBallSummary(
      { balls: [ball("r1"), ball("r2")], summary: { total: 108 } },
      { now: NOW + 1, state: first.state },
    )
    expect(grown.send).toBe(true)
    expect(grown.state?.total).toBe(108)
  })

  it("re-surfaces when the withheld count changes", () => {
    const first = decidePendingBallSummary(
      { balls: [ball("r1")], summary: { total: 9, withheld: { total: 8 } } },
      { now: NOW, state: null },
    )
    const changed = decidePendingBallSummary(
      { balls: [ball("r1")], summary: { total: 9, withheld: { total: 4 } } },
      { now: NOW + 1, state: first.state },
    )
    expect(changed.send).toBe(true)
    expect(changed.state?.withheld).toBe(4)
  })

  it("resets on empty and treats the next nonempty set as a first send", () => {
    const first = decidePendingBallSummary({ balls: [ball("r1")], summary: { total: 1 } }, { now: NOW, state: null })
    const empty = decidePendingBallSummary({ balls: [], summary: { total: 0 } }, { now: NOW + 1, state: first.state })
    expect(empty.send).toBe(false)
    expect(empty.state).toBeNull()
    const again = decidePendingBallSummary(
      { balls: [ball("r1")], summary: { total: 1 } },
      { now: NOW + 2, state: empty.state },
    )
    expect(again.send).toBe(true)
  })
})

// 27346 — the daemon's `replay` flag is cursor-based, and registration
// tail-resets the session cursor to the log tail, so a never-delivered recovery
// row reads replay:true. Delivery-to-this-pane is adapter-local: this filter
// admits each attention row once, and only once.
describe("createForwardedAttentionTracker (27346 per-pane delivery record)", () => {
  it("does not count a row before the handoff is recorded", () => {
    const tracker = createForwardedAttentionTracker()
    expect(tracker.has("row-a")).toBe(false)
    tracker.remember("row-a")
    expect(tracker.has("row-a")).toBe(true)
  })

  it("keeps suppressing an id once its handoff is recorded", () => {
    const tracker = createForwardedAttentionTracker()
    tracker.remember("row-a")
    expect(tracker.has("row-a")).toBe(true)
    expect(tracker.has("row-b")).toBe(false)
    tracker.remember("row-b")
    expect(tracker.has("row-b")).toBe(true)
  })

  it("never reports an undefined id as forwarded — never withhold a row we cannot key", () => {
    const tracker = createForwardedAttentionTracker()
    expect(tracker.has(undefined)).toBe(false)
    tracker.remember(undefined)
    expect(tracker.has(undefined)).toBe(false)
  })

  it("evicts the oldest id past the bound rather than growing without limit", () => {
    const tracker = createForwardedAttentionTracker(2)
    tracker.remember("row-a")
    tracker.remember("row-b")
    tracker.remember("row-c") // evicts row-a
    expect(tracker.has("row-b")).toBe(true)
    expect(tracker.has("row-a")).toBe(false) // evicted, so admissible again
  })
})
