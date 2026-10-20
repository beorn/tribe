/**
 * @failure A members reader turns legacy/malformed transport data into an offline or healthy seat verdict.
 * @level l0
 * @consumer tribe.members producer and its shared public readers (30299)
 * @testonly none
 * Existing socket-framing tests do not validate the semantic members contract.
 */
import { describe, expect, it } from "vitest"
import { parseMembersObservation } from "../src/barrels/records.ts"

const member = {
  member_id: "reader",
  name: "@dev/reader",
  launch_id: "reader@1",
  registration: { source: "durable-launch", state: "registered", registered_at_ms: 100 },
  transport_registered: false,
  transport_state: "disconnected",
  owner_state: "unknown",
  transport_reason: "owner-unknown-no-transport",
  transport_observed_at_ms: 500,
  transport_pids: [],
  mailbox_read_capability: {
    state: "available",
    evidence_kind: "observed",
    reason: "self-mailbox-authority-token",
  },
  mailbox_progress: {
    state: "observed",
    scope: "mailbox-name",
    observed_at_ms: 500,
    last_attention_read_at_ms: 400,
    last_attention_read_age_ms: 100,
  },
}
const envelope = (row: unknown = member) => ({ schema: "tribe-members/2", sessions: [row] })

describe("the public members observation parser", () => {
  it("preserves disconnected transport and a real name-scoped read as independent facts", () => {
    const value = envelope({ ...member, provider: "codex", account: "registered-account" })
    expect(parseMembersObservation(value)).toEqual(value)
  })

  it("preserves unknown reads and explicit missing mailbox authority without fabricating progress", () => {
    const value = envelope({
      ...member,
      mailbox_read_capability: {
        state: "unavailable",
        evidence_kind: "observed",
        reason: "self-mailbox-authority-missing",
      },
      mailbox_progress: {
        state: "unobserved",
        scope: "mailbox-name",
        observed_at_ms: 500,
        last_attention_read_at_ms: null,
        last_attention_read_age_ms: null,
        reason: "no-canonical-read-receipt",
      },
    })
    expect(parseMembersObservation(value)).toEqual(value)
  })

  it.each([
    { sessions: [] },
    { schema: "tribe-members/1", sessions: [{ name: "@dev/reader", alive: false }] },
    { schema: "tribe-members/2", sessions: null },
    envelope({ ...member, member_id: "" }),
    envelope({ ...member, registration: null }),
    envelope({ ...member, transport_state: "offline" }),
    envelope({ ...member, owner_state: "absent" }),
    envelope({ ...member, transport_observed_at_ms: Number.NaN }),
    envelope({ ...member, mailbox_progress: { ...member.mailbox_progress, last_attention_read_at_ms: null } }),
    envelope({ ...member, mailbox_progress: { ...member.mailbox_progress, last_attention_read_age_ms: -1 } }),
    envelope({
      ...member,
      mailbox_read_capability: {
        state: "available",
        evidence_kind: "observed",
        reason: "self-mailbox-authority-missing",
      },
    }),
    envelope({ ...member, alive: false }),
    envelope({ ...member, agent_pid: 123 }),
    { ...envelope(), finished_launches: [{ name: "@dev/old", launch_parent_pid: 123 }] },
  ])("fails the existing read boundary loudly for an incompatible or incomplete observation %#", (value) => {
    expect(() => parseMembersObservation(value)).toThrow(/tribe\.members.*tribe-members\/2/)
  })

  it("keeps connector refusal PIDs distinct from forbidden supervisor fields", () => {
    const value = envelope({ ...member, last_refusal: { kind: "identity", pid: 123 } })
    expect(parseMembersObservation(value)).toEqual(value)
  })

  it("accepts an explicitly current empty roster without synthesizing a row", () => {
    expect(parseMembersObservation({ schema: "tribe-members/2", sessions: [] })).toEqual({
      schema: "tribe-members/2",
      sessions: [],
    })
  })
})
