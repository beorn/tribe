import { describe, expect, it } from "vitest"
import {
  projectSessionLiveness,
  projectSessionTransportEvidence,
  projectSessionTransportState,
} from "./session-transport-state.ts"

const NOW = 1_800_000_000_000
const LIVE_TRANSPORT = { transportConnected: true, transportPids: [41], agentPid: 42, probe: () => "live" as const }
/** Consumer evidence that satisfies everything but the transport, for cases about the transport. */
const CONSUMED = { consumers: ["push-client"] as const, mailboxReadable: true, lastMailboxReadAt: null }

describe("daemon-authoritative session transport state", () => {
  it("treats an authenticated registry entry with no contrary pid evidence as connected", () => {
    expect(projectSessionTransportState({ transportConnected: true })).toEqual({
      transport_registered: true,
      transport_state: "connected",
      owner_state: "live",
      transport_reason: "registered-transport",
    })
  })

  it("does not turn a disconnected row's reusable numeric PID into owner identity", () => {
    expect(projectSessionTransportState({ transportConnected: false })).toEqual({
      transport_registered: false,
      transport_state: "disconnected",
      owner_state: "unknown",
      transport_reason: "owner-unknown-no-transport",
    })
  })

  it("projects a registered transport whose own pids are dead as disconnected", () => {
    // The registration is real and stays visible as `transport_registered`,
    // but registry presence is belief, not evidence: a socket-close handler
    // that hasn't fired yet leaves an entry behind. Six live sessions read
    // `connected` with dead pids on 2026-08-13 and nearly mis-planned a
    // fleet-wide recovery.
    expect(projectSessionTransportState({ transportConnected: true, transportPidsAlive: false })).toEqual({
      transport_registered: true,
      transport_state: "disconnected",
      owner_state: "dead",
      transport_reason: "registered-transport-pids-dead",
    })
  })

  it("keeps a transport with no known pids connected — absence of pids is not death", () => {
    expect(projectSessionTransportState({ transportConnected: true, transportPidsAlive: true })).toEqual({
      transport_registered: true,
      transport_state: "connected",
      owner_state: "live",
      transport_reason: "registered-transport",
    })
  })

  it("never reports a live transport alongside a dead pid", () => {
    expect(projectSessionLiveness({ transportConnected: true, pidAlive: false })).toEqual({
      alive: false,
      transport_alive: false,
      agent_alive: true,
      pid_alive: false,
      is_silent: false,
    })
  })

  it("reports alive=false when agent process is dead even if MCP transport is connected (22317)", () => {
    expect(
      projectSessionLiveness({
        transportConnected: true,
        agentPidAlive: false,
      }),
    ).toEqual({
      alive: false,
      transport_alive: true,
      agent_alive: false,
      pid_alive: true,
      is_silent: false,
    })
  })

  it("reports alive=false when seat is silent beyond threshold (22317)", () => {
    expect(
      projectSessionLiveness({
        transportConnected: true,
        agentPidAlive: true,
        lastSeenSec: 15234, // ~4h14m
      }),
    ).toEqual({
      alive: false,
      transport_alive: true,
      agent_alive: true,
      pid_alive: true,
      is_silent: true,
    })
  })

  it("uses one PID-aware projection for answer-capability admission", () => {
    expect(
      projectSessionTransportEvidence({
        transportConnected: true,
        transportPids: [41],
        agentPid: 42,
        probe: () => "live",
        ...CONSUMED,
      }),
    ).toMatchObject({
      transport_state: "connected",
      owner_state: "live",
      answer_capability: "observed",
      answer_reason: "connected-pid-live-transport",
    })
    expect(
      projectSessionTransportEvidence({
        transportConnected: true,
        transportPids: [41],
        agentPid: 42,
        probe: (pid) => (pid === 41 ? "dead" : "live"),
        // A dead transport reads as transport-down even when the mailbox is
        // also unreadable: the transport reason outranks the mailbox reason.
        ...CONSUMED,
        mailboxReadable: false,
      }),
    ).toMatchObject({
      transport_registered: true,
      transport_state: "disconnected",
      owner_state: "dead",
      answer_capability: "not-observed",
      answer_reason: "registered-transport-pids-dead",
    })
  })

  it("does not promote silence or disconnected historical rows into an owner identity claim", () => {
    expect(
      projectSessionTransportEvidence({
        transportConnected: true,
        transportPids: [],
        agentPid: null,
        lastSeenSec: 15_234,
        ...CONSUMED,
      }),
    ).toMatchObject({ alive: false, is_silent: true, answer_capability: "observed" })
    expect(
      projectSessionTransportEvidence({
        transportConnected: false,
        transportPids: [41],
        agentPid: 42,
        probe: () => "live",
        ...CONSUMED,
      }),
    ).toMatchObject({
      transport_registered: false,
      transport_state: "disconnected",
      owner_state: "unknown",
      answer_capability: "not-observed",
      answer_reason: "owner-unknown-no-transport",
    })
  })

  // 24664: a PID-live transport says the seat CAN be reached, not that anything
  // is reading. Answer capability needs a consumer and a readable mailbox, and
  // the read age travels with the reason so a sender can tell "reads at its
  // next tick" from "unreachable".
  it("does not count a PID-live session that nothing consumes as able to answer", () => {
    expect(
      projectSessionTransportEvidence({
        ...LIVE_TRANSPORT,
        consumers: [],
        mailboxReadable: true,
        lastMailboxReadAt: NOW - 240_000,
        now: NOW,
      }),
    ).toMatchObject({
      transport_state: "connected",
      transport_alive: true,
      agent_alive: true,
      answer_capability: "not-observed",
      answer_reason: "connected-no-consumer",
      last_mailbox_read_age_ms: 240_000,
    })
    expect(
      projectSessionTransportEvidence({
        ...LIVE_TRANSPORT,
        consumers: [],
        mailboxReadable: true,
        lastMailboxReadAt: null,
        now: NOW,
      }),
    ).toMatchObject({ answer_reason: "connected-no-consumer", last_mailbox_read_age_ms: null })
  })

  it.each(["inbox-wait", "push-client"] as const)("counts a live %s consumer as able to answer", (consumer) => {
    expect(
      projectSessionTransportEvidence({
        ...LIVE_TRANSPORT,
        consumers: [consumer],
        mailboxReadable: true,
        lastMailboxReadAt: NOW - 240_000,
        now: NOW,
      }),
    ).toMatchObject({
      answer_capability: "observed",
      answer_reason: "connected-pid-live-transport",
      last_mailbox_read_age_ms: 240_000,
    })
  })

  it("reports an unreadable mailbox in the same field, even while a consumer waits (24576)", () => {
    expect(
      projectSessionTransportEvidence({
        ...LIVE_TRANSPORT,
        consumers: ["inbox-wait"],
        mailboxReadable: false,
        lastMailboxReadAt: NOW - 60_000,
        now: NOW,
      }),
    ).toMatchObject({
      transport_alive: true,
      answer_capability: "not-observed",
      answer_reason: "mailbox-read-unavailable",
      last_mailbox_read_age_ms: 60_000,
    })
  })
})
