// 20703/21049 — transport-status transitions publish over the health rail.
//
// The adapter already computes `requiredMcpTransportHealth` (advertised/live/
// closed + reason) but it dead-ended locally: chief/deck could not see an
// adapter's advertised→live→closed churn, so the recurrence looked like a daemon
// problem. On every status TRANSITION (change only, not repeats) the adapter now
// best-effort publishes over the EXISTING `tribe.health.publish` rail, gated to
// managed explicit-persona launches so anonymous pull adapters add no noise.
//
// This is a grep-guard: it reads the adapter SOURCE as text and never imports the
// module (the adapter constructs an MCP Server + connects stdio at load time, so
// importing it has side effects we don't want in a unit test) — same convention
// as stdio-adapter-instructions.test.ts.

import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src/stdio-adapter.ts")
const src = readFileSync(SRC, "utf8")

describe("20703/21049 — transport-status transitions publish over the health rail", () => {
  it("defines a transport-transition publisher that calls the health-publish rail", () => {
    expect(src).toContain("function publishRequiredMcpTransportTransition")
    expect(src).toContain('call("tribe.health.publish"')
  })

  it("publishes only on a status CHANGE, not on repeats", () => {
    expect(src).toMatch(/requiredMcpTransportHealth\.status !== status/)
  })

  it("no-ops the publish for anonymous (non-launch-name) sessions", () => {
    expect(src).toMatch(/publishRequiredMcpTransportTransition[\s\S]{0,400}?if \(!REGISTER_WITH_LAUNCH_NAME\) return/)
  })

  it("carries launch + transport identity so consumers can attribute the churn", () => {
    // Inside the publisher, not the pre-existing failure-result string.
    expect(src).toMatch(/publishRequiredMcpTransportTransition[\s\S]{0,600}?launch_id=\$\{launchId\}/)
    expect(src).toMatch(/publishRequiredMcpTransportTransition[\s\S]{0,600}?transport_pid=\$\{process\.pid\}/)
  })
})
