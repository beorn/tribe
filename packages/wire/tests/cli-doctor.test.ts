/**
 * @km/tribe/20033 prevention — `tribe doctor` staleness probe.
 *
 * The in-daemon code_pin detector cannot catch a daemon too old to contain it
 * (it lives inside the daemon), so the probe lives in the CLI:
 * `evaluateDoctorIdentity` takes the daemon's startup cert and probes on-disk
 * and pin itself at the daemon's root, with no self-verdict from the daemon.
 * The classes below unit-test it without a live socket.
 */

import { describe, expect, test } from "vitest"
import type { MemberObservation } from "../src/barrels/records.ts"
import {
  deriveDoctorOutcome,
  evaluateDoctorIdentity,
  evaluateDoctorBridgeLost,
  evaluateDoctorHealthSample,
  evaluateDoctorMembership,
  evaluateDoctorVersions,
} from "../src/cli/read.ts"
import { mcpJsonContent } from "../src/cli/mcp-json-content.ts"

describe("mcpJsonContent (MCP tool-result unwrap, shared by health + doctor)", () => {
  test("MCP-wrapped JSON content → parsed object", () => {
    const wrapped = { content: [{ type: "text", text: JSON.stringify({ code_pin: { stale: false } }) }] }
    expect(mcpJsonContent(wrapped)).toEqual({ code_pin: { stale: false } })
  })

  test("no content array (raw object reply) → returned as-is", () => {
    const raw = { code_pin: { stale: true } }
    expect(mcpJsonContent(raw)).toBe(raw)
  })

  test("content present but not JSON → falls back to the raw value (no throw)", () => {
    const wrapped = { content: [{ type: "text", text: "not json {" }] }
    expect(mcpJsonContent(wrapped)).toBe(wrapped)
  })

  test("null / undefined → returned verbatim (caller guards)", () => {
    expect(mcpJsonContent(null)).toBeNull()
    expect(mcpJsonContent(undefined)).toBeUndefined()
  })
})

describe("deriveDoctorOutcome (worst-of verdict algebra)", () => {
  test.each([
    { checks: ["OK", "OK"], expected: { verdict: "OK", exitCode: 0 } },
    { checks: ["OK", "WARNING"], expected: { verdict: "WARNING", exitCode: 3 } },
    { checks: ["WARNING", "CRITICAL"], expected: { verdict: "FAIL", exitCode: 1 } },
    { checks: ["WARNING", "UNKNOWN"], expected: { verdict: "UNKNOWN", exitCode: 2 } },
    { checks: ["OK", "CRITICAL"], expected: { verdict: "FAIL", exitCode: 1 } },
    { checks: ["CRITICAL", "UNKNOWN"], expected: { verdict: "UNKNOWN", exitCode: 2 } },
  ] as const)("derives $expected.verdict from $checks", ({ checks, expected }) => {
    expect(deriveDoctorOutcome(checks)).toEqual(expected)
  })
})

function doctorMember(name: string, changes: Partial<MemberObservation> = {}): MemberObservation {
  return {
    name,
    member_id: name,
    launch_id: name,
    registration: { source: "durable-launch", state: "registered", registered_at_ms: 1 },
    transport_registered: false,
    transport_state: "disconnected",
    owner_state: "unknown",
    transport_reason: "owner-unknown-no-transport",
    transport_observed_at_ms: 10,
    transport_pids: [],
    mailbox_read_capability: { state: "available", evidence_kind: "observed", reason: "self-mailbox-authority-token" },
    mailbox_progress: {
      state: "observed",
      scope: "mailbox-name",
      observed_at_ms: 10,
      last_attention_read_at_ms: 8,
      last_attention_read_age_ms: 2,
    },
    ...changes,
  }
}

describe("status-backed doctor checks", () => {
  const success = (value: string) => ({ ok: true as const, value })

  test("a daemon whose cli_status reports no code_identity is UNKNOWN with the reload remedy (20033 bootstrap)", () => {
    // cmdDoctor passes reportedIdentity === undefined here: status.daemon?.code_identity
    // is absent on a daemon too old to self-report — the class the deleted
    // evaluateDoctor used to pin on the daemon's *health* shape.
    const check = evaluateDoctorIdentity(undefined, undefined, null)
    expect(check.severity).toBe("UNKNOWN")
    expect(check.diagnosis).toContain("UNSUPPORTED_CODE_IDENTITY")
    expect(check.remedy).toMatch(/reload the daemon/)
    expect(check.remedy).toContain("tribe doctor")
  })

  test("three equal certs are the only green identity result", () => {
    const check = evaluateDoctorIdentity(
      { cert: "abc123", root: "/repo/vendor/tribe" },
      { onDisk: success("abc123"), superprojectPin: success("abc123") },
      null,
    )
    expect(check).toMatchObject({ severity: "OK", values: { running: "abc123", on_disk: "abc123", pin: "abc123" } })
  })

  test("running vs disk mismatch is CRITICAL without assuming a different source root", () => {
    const check = evaluateDoctorIdentity(
      { cert: "old123", root: "/repo/vendor/tribe" },
      { onDisk: success("new456"), superprojectPin: success("new456") },
      null,
    )
    expect(check).toMatchObject({ severity: "CRITICAL" })
    expect(check.diagnosis).toContain("running=old123 on_disk=new456")
    expect(check.remedy).toContain("/repo/vendor/tribe")
    expect(check.remedy).toContain("compare")
    expect(check.remedy).toContain("reload")
    expect(check.remedy).toContain("tribe doctor")
    expect(check.remedy).not.toContain("different module root")
    expect(check.remedy).not.toContain("restarting will not help")
  })

  test("disk vs superproject pin mismatch is WARNING with the exact source root, checkout-behind", () => {
    const check = evaluateDoctorIdentity(
      { cert: "old123", root: "/repo/vendor/tribe" },
      { onDisk: success("old123"), superprojectPin: success("new456") },
      "checkout-behind",
    )
    expect(check).toMatchObject({ severity: "WARNING" })
    expect(check.diagnosis).toContain("on_disk=old123 pin=new456")
    expect(check.diagnosis).toMatch(/behind/i)
    expect(check.remedy).toContain("/repo/vendor/tribe")
  })

  test("checkout AHEAD of its host pin must NOT emit the rollback remedy (live specimen 2026-08-13)", () => {
    // Same live specimen as code-pin.test.ts: on_disk c15f7d1bb7aa was 6
    // commits ahead of pin 60a5c3c8816a. The un-fixed evaluateDoctorIdentity
    // treats any on_disk!=pin mismatch as "checkout is behind" and tells the
    // operator to materialize the (older) pin — a rollback dressed as a fix.
    const check = evaluateDoctorIdentity(
      { cert: "c15f7d1bb7aa", root: "/repo/vendor/tribe" },
      { onDisk: success("c15f7d1bb7aa"), superprojectPin: success("60a5c3c8816a") },
      "checkout-ahead",
    )
    expect(check.severity).not.toBe("UNKNOWN")
    expect(check.diagnosis).not.toMatch(/is behind/i)
    expect(check.diagnosis).toMatch(/ahead/i)
    expect(check.remedy).not.toContain("materialize its pinned Tribe submodule")
    expect(check.remedy).toMatch(/no daemon action/i)
  })

  test("diverged checkout and pin recommend investigation, no mechanical remedy", () => {
    const check = evaluateDoctorIdentity(
      { cert: "1111", root: "/repo/vendor/tribe" },
      { onDisk: success("1111"), superprojectPin: success("2222") },
      "divergent",
    )
    expect(check.diagnosis).toMatch(/diverged/i)
    expect(check.remedy).not.toContain("materialize its pinned Tribe submodule")
  })

  test("unresolvable ancestry (unknown-object) is UNKNOWN, never guessed toward a remedy", () => {
    const check = evaluateDoctorIdentity(
      { cert: "3333", root: "/repo/vendor/tribe" },
      { onDisk: success("3333"), superprojectPin: success("4444") },
      "unknown",
    )
    expect(check.severity).toBe("UNKNOWN")
    expect(check.diagnosis).toMatch(/unknown-direction/i)
    expect(check.remedy).not.toContain("materialize its pinned Tribe submodule")
  })

  test("an unresolvable disk probe is UNKNOWN with path and errno", () => {
    const check = evaluateDoctorIdentity(
      { cert: "abc123", root: "/missing/tribe" },
      {
        onDisk: {
          ok: false,
          failure: {
            path: "/missing/tribe",
            operation: "git rev-parse HEAD",
            errno: "ENOENT",
            message: "not found",
          },
        },
        superprojectPin: success("abc123"),
      },
      null,
    )
    expect(check).toMatchObject({ severity: "UNKNOWN" })
    expect(check.diagnosis).toContain("path=/missing/tribe")
    expect(check.diagnosis).toContain("errno=ENOENT")
  })

  // `--show-superproject-working-tree` exits 0 with empty output when the
  // checkout is standalone (not embedded as a submodule) — CI's own checkout
  // of tribe included. `probeGitValue` folds that into EMPTY_RESULT, distinct
  // from every other probe failure. That is a fact about checkout shape, not
  // an error, so identity must not go UNKNOWN over it — it reduces to
  // running-vs-on-disk only.
  test("no superproject (EMPTY_RESULT) with a matching checkout is OK, not UNKNOWN", () => {
    const check = evaluateDoctorIdentity(
      { cert: "abc123", root: "/repo/tribe" },
      {
        onDisk: success("abc123"),
        superprojectPin: {
          ok: false,
          failure: {
            path: "/repo/tribe",
            operation: "git rev-parse --show-superproject-working-tree",
            errno: "EMPTY_RESULT",
            message: "git returned no value",
          },
        },
      },
      null,
    )
    expect(check).toMatchObject({ severity: "OK" })
    expect(check.diagnosis).toContain("running=abc123 on_disk=abc123")
    expect(check.diagnosis).toContain("pin=none")
  })

  test("no superproject (EMPTY_RESULT) with a running/on-disk mismatch is still CRITICAL", () => {
    const check = evaluateDoctorIdentity(
      { cert: "old123", root: "/repo/tribe" },
      {
        onDisk: success("new456"),
        superprojectPin: {
          ok: false,
          failure: {
            path: "/repo/tribe",
            operation: "git rev-parse --show-superproject-working-tree",
            errno: "EMPTY_RESULT",
            message: "git returned no value",
          },
        },
      },
      null,
    )
    expect(check).toMatchObject({ severity: "CRITICAL" })
    expect(check.diagnosis).toContain("running=old123 on_disk=new456")
    expect(check.remedy).toContain("/repo/tribe")
    expect(check.remedy).toContain("compare")
    expect(check.remedy).toContain("reload")
    expect(check.remedy).toContain("tribe doctor")
    expect(check.remedy).not.toContain("different module root")
    expect(check.remedy).not.toContain("restarting will not help")
  })

  test("a non-EMPTY_RESULT superproject probe failure stays UNKNOWN", () => {
    const check = evaluateDoctorIdentity(
      { cert: "abc123", root: "/repo/tribe" },
      {
        onDisk: success("abc123"),
        superprojectPin: {
          ok: false,
          failure: {
            path: "/repo/tribe",
            operation: "git rev-parse --show-superproject-working-tree",
            errno: "ENOENT",
            message: "git not found",
          },
        },
      },
      null,
    )
    expect(check).toMatchObject({ severity: "UNKNOWN" })
    expect(check.diagnosis).toContain("errno=ENOENT")
  })

  test("negotiated legacy transport is version-degraded WARNING, not healthy", () => {
    const check = evaluateDoctorVersions(10, [
      { name: "@dev/0", protocol_versions: [10], version_state: "current" },
      { name: "@dev/1", protocol_versions: [9], version_state: "version-degraded" },
    ])
    expect(check).toMatchObject({ severity: "WARNING" })
    expect(check.diagnosis).toContain("@dev/1=version-degraded(v9)")
  })

  test("membership observations name transport, authority, READ and unknown registration independently", () => {
    const check = evaluateDoctorMembership(
      [doctorMember("@dev/0", { transport_state: "connected" }), doctorMember("@dev/1")],
      { status: "degraded", missing: [{ name: "@dev/2", state: "missing-transport" }] },
    )
    expect(check.severity).toBe("UNKNOWN")
    expect(check.diagnosis).toContain("@dev/0 transport=connected")
    expect(check.diagnosis).toContain("@dev/1 transport=disconnected")
    expect(check.diagnosis).toContain("@dev/2 transport=missing-transport")
    expect(check.diagnosis).toContain("agent process=unobserved")
  })

  test("a CLI reader with a real mailbox read needs no MCP reconnect from socket absence", () => {
    const check = evaluateDoctorMembership([doctorMember("@dev/2")], {
      status: "degraded",
      missing: [{ name: "@dev/2", state: "missing-transport" }],
    })
    expect(check.severity).toBe("OK")
    expect(check.remedy).toBeUndefined()
    expect(check.diagnosis).toContain("mailbox authority=available")
    expect(check.diagnosis).toContain("canonical mailbox READ=8 age=2ms scope=mailbox-name observed_at=10")
  })

  test("missing authority and unobserved READ name their sources without prescribing reconnect", () => {
    const unread = {
      state: "unobserved",
      scope: "mailbox-name",
      observed_at_ms: 10,
      last_attention_read_at_ms: null,
      last_attention_read_age_ms: null,
      reason: "no-canonical-read-receipt",
    } as const
    const unavailable = evaluateDoctorMembership(
      [
        doctorMember("@dev/2", {
          mailbox_read_capability: {
            state: "unavailable",
            evidence_kind: "observed",
            reason: "self-mailbox-authority-missing",
          },
          mailbox_progress: unread,
        }),
      ],
      undefined,
    )
    expect(unavailable.severity).toBe("WARNING")
    expect(unavailable.remedy).toContain("mailbox authority")
    const unknown = evaluateDoctorMembership([doctorMember("@dev/2", { mailbox_progress: unread })], undefined)
    expect(unknown.severity).toBe("UNKNOWN")
    expect(unknown.diagnosis).toContain("canonical mailbox READ=unobserved")
    expect(unknown.remedy).not.toContain("Reconnect")
  })
})

describe("evaluateDoctorHealthSample (24248, @cto bace5ece)", () => {
  const stats = { started: 90, completed: 89, failed: 0, inFlight: true, maxObservedRunMs: 12_400 }

  test("a sample skipping ticks right now is a WARNING that counts them", () => {
    expect(evaluateDoctorHealthSample({ ...stats, skipped: 5, consecutiveSkips: 2 })).toEqual({
      severity: "WARNING",
      diagnosis:
        "health sample behind: 2 tick(s) skipped in a row now, 5 since start (90 samples, longest sample 12.4s)",
      remedy:
        "read the daemon log's `health-sample: skipped tick` lines for how long the running sample has taken; a census " +
        "that outruns the tick is the host's load or a pathological journal walk",
    })
  })

  test("a sample back on cadence is OK and still says how many ticks it skipped", () => {
    expect(evaluateDoctorHealthSample({ ...stats, skipped: 5, consecutiveSkips: 0 })).toEqual({
      severity: "OK",
      diagnosis: "health sample on cadence: 5 skipped tick(s) since start (90 samples, longest sample 12.4s)",
    })
  })

  test("a daemon that reports no cadence is UNKNOWN, never assumed on time", () => {
    expect(evaluateDoctorHealthSample(null)).toEqual({
      severity: "UNKNOWN",
      diagnosis:
        "health sample cadence unreported: the running daemon predates 24248's rail count or its health monitor is off",
    })
  })
})

describe("evaluateDoctorBridgeLost (25662)", () => {
  test("armed paging is OK and names its owners and grace", () => {
    expect(evaluateDoctorBridgeLost({ armed: true, config: { owners: ["@chief", "@cto"], graceMs: 180_000 } })).toEqual(
      { severity: "OK", diagnosis: "bridge-lost paging armed: owners=@chief,@cto grace=180s" },
    )
  })

  test("disarmed paging is a WARNING that prints its reason", () => {
    expect(evaluateDoctorBridgeLost({ armed: false, reason: "TRIBE_BRIDGE_LOST_OWNERS is unset" })).toEqual({
      severity: "WARNING",
      diagnosis: "bridge-lost paging disarmed: TRIBE_BRIDGE_LOST_OWNERS is unset",
      remedy:
        "set TRIBE_BRIDGE_LOST_OWNERS to two or more seats (comma-separated) in the daemon's environment, then restart the daemon",
    })
  })

  test("a daemon that reports no arming is UNKNOWN, never assumed armed", () => {
    expect(evaluateDoctorBridgeLost(undefined)).toEqual({
      severity: "UNKNOWN",
      diagnosis: "bridge-lost paging state unreported: the running daemon predates 25662 or its health monitor is off",
    })
  })
})
