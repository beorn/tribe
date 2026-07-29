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
import { evaluateDoctor } from "../src/cli/read.ts"
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
  test("missing code_pin field → stale (bootstrap gap: daemon too old to self-report)", () => {
    const v = evaluateDoctor({})
    expect(v.stale).toBe(true)
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
    expect(v.stale).toBe(true)
    expect(v.reason).toBe("running abc123 != on_disk def456 — restart the daemon")
    expect(v.detail).toEqual({ running: "abc123", on_disk: "def456", superproject_pin: "def456" })
  })

  test("code_pin present and fresh → not stale", () => {
    const v = evaluateDoctor({
      code_pin: { stale: false, reason: null, running: "abc123", on_disk: "abc123", superproject_pin: "abc123" },
    })
    expect(v.stale).toBe(false)
    expect(v.reason).toBeNull()
    expect(v.detail).toEqual({ running: "abc123", on_disk: "abc123", superproject_pin: "abc123" })
  })

  test("null code_pin SHAs (standalone / no-git) but not stale → reported as fresh, SHAs surfaced as null", () => {
    const v = evaluateDoctor({
      code_pin: { stale: false, reason: null, running: null, on_disk: null, superproject_pin: null },
    })
    expect(v.stale).toBe(false)
    expect(v.detail).toEqual({ running: null, on_disk: null, superproject_pin: null })
  })
})
