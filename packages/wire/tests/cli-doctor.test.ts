/**
 * @km/tribe/20033 prevention — `tribe doctor` staleness probe.
 *
 * The in-daemon code_pin detector cannot catch a daemon too old to contain it
 * (it lives inside the daemon). `evaluateDoctor` is the outside probe: it reads
 * a daemon's `tribe.health()` and treats a MISSING `code_pin` field as a
 * positive staleness signal — a known-current field absent from a method fresh
 * daemons always populate proves the daemon predates the detector. Pure, so the
 * three staleness classes unit-test without a live socket.
 */

import { describe, expect, test } from "vitest"
import {
  deriveDoctorOutcome,
  evaluateDoctor,
  evaluateDoctorIdentity,
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

describe("evaluateDoctor (@km/tribe/20033 daemon staleness probe)", () => {
  test("missing code_pin field → UNKNOWN (bootstrap gap: daemon too old to self-report)", () => {
    const v = evaluateDoctor({})
    expect(v.outcome).toEqual({ verdict: "UNKNOWN", exitCode: 2 })
    expect(v.reason).toMatch(/predates the code_pin detector/)
    // No SHAs available — the daemon could not self-report.
    expect(v.detail).toBeNull()
  })

  test("code_pin present and stale → stale; surfaces the daemon's own reason + SHAs", () => {
    const v = evaluateDoctor({
      code_pin: {
        stale: true,
        reason: "running abc123 != on_disk def456 — restart the daemon",
        running: "abc123",
        on_disk: "def456",
        superproject_pin: "def456",
      },
    })
    expect(v.outcome).toEqual({ verdict: "FAIL", exitCode: 1 })
    expect(v.reason).toBe("running abc123 != on_disk def456 — restart the daemon")
    expect(v.detail).toEqual({ running: "abc123", on_disk: "def456", superproject_pin: "def456" })
  })

  test("code_pin present and fresh → not stale", () => {
    const v = evaluateDoctor({
      code_pin: { stale: false, reason: null, running: "abc123", on_disk: "abc123", superproject_pin: "abc123" },
    })
    expect(v.outcome).toEqual({ verdict: "OK", exitCode: 0 })
    expect(v.reason).toBeNull()
    expect(v.detail).toEqual({ running: "abc123", on_disk: "abc123", superproject_pin: "abc123" })
  })

  test.each(["running", "on_disk", "superproject_pin"] as const)(
    "an unresolved %s operand makes equality UNKNOWN and never OK",
    (field) => {
      const codePin = {
        stale: false,
        reason: null,
        running: "abc123" as string | null,
        on_disk: "abc123" as string | null,
        superproject_pin: "abc123" as string | null,
      }
      codePin[field] = null
      const v = evaluateDoctor({ code_pin: codePin })

      expect(v.outcome).toEqual({ verdict: "UNKNOWN", exitCode: 2 })
      expect(v.reason).toContain(field)
      expect(v.detail).toEqual({
        running: codePin.running,
        on_disk: codePin.on_disk,
        superproject_pin: codePin.superproject_pin,
      })
    },
  )

  test("all unresolved code_pin operands cannot certify a standalone / no-git daemon", () => {
    const v = evaluateDoctor({
      code_pin: { stale: false, reason: null, running: null, on_disk: null, superproject_pin: null },
    })
    expect(v.outcome).toEqual({ verdict: "UNKNOWN", exitCode: 2 })
    expect(v.reason).toContain("running")
    expect(v.reason).toContain("on_disk")
    expect(v.reason).toContain("superproject_pin")
    expect(v.detail).toEqual({ running: null, on_disk: null, superproject_pin: null })
  })
})

describe("deriveDoctorOutcome (worst-of verdict algebra)", () => {
  test.each([
    { checks: ["OK", "OK"], expected: { verdict: "OK", exitCode: 0 } },
    { checks: ["OK", "WARNING"], expected: { verdict: "FAIL", exitCode: 1 } },
    { checks: ["OK", "CRITICAL"], expected: { verdict: "FAIL", exitCode: 1 } },
    { checks: ["CRITICAL", "UNKNOWN"], expected: { verdict: "UNKNOWN", exitCode: 2 } },
  ] as const)("derives $expected.verdict from $checks", ({ checks, expected }) => {
    expect(deriveDoctorOutcome(checks)).toEqual(expected)
  })
})

describe("status-backed doctor checks", () => {
  const success = (value: string) => ({ ok: true as const, value })

  test("three equal certs are the only green identity result", () => {
    const check = evaluateDoctorIdentity(
      { cert: "abc123", root: "/repo/vendor/tribe" },
      { onDisk: success("abc123"), superprojectPin: success("abc123") },
    )
    expect(check).toMatchObject({ severity: "OK", values: { running: "abc123", on_disk: "abc123", pin: "abc123" } })
  })

  test("running vs disk mismatch is CRITICAL with a diagnosis-derived restart remedy", () => {
    const check = evaluateDoctorIdentity(
      { cert: "old123", root: "/repo/vendor/tribe" },
      { onDisk: success("new456"), superprojectPin: success("new456") },
    )
    expect(check).toMatchObject({ severity: "CRITICAL" })
    expect(check.diagnosis).toContain("running=old123 on_disk=new456")
    expect(check.remedy).toContain("restarting will not help")
    expect(check.remedy).toContain("daemon module root")
  })

  test("disk vs superproject pin mismatch is WARNING with the exact source root", () => {
    const check = evaluateDoctorIdentity(
      { cert: "old123", root: "/repo/vendor/tribe" },
      { onDisk: success("old123"), superprojectPin: success("new456") },
    )
    expect(check).toMatchObject({ severity: "WARNING" })
    expect(check.diagnosis).toContain("on_disk=old123 pin=new456")
    expect(check.remedy).toContain("/repo/vendor/tribe")
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
    )
    expect(check).toMatchObject({ severity: "UNKNOWN" })
    expect(check.diagnosis).toContain("path=/missing/tribe")
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

  test("membership discrepancy is WARNING and names every per-seat rail state", () => {
    const check = evaluateDoctorMembership(
      [
        { name: "@dev/0", transport_state: "connected" },
        { name: "@dev/1", transport_state: "disconnected" },
      ],
      {
        status: "degraded",
        missing: [{ name: "@dev/2", state: "missing-transport" }],
      },
    )
    expect(check).toMatchObject({ severity: "WARNING" })
    expect(check.diagnosis).toContain("@dev/0=connected")
    expect(check.diagnosis).toContain("@dev/1=disconnected")
    expect(check.diagnosis).toContain("@dev/2=missing-transport")
  })
})
