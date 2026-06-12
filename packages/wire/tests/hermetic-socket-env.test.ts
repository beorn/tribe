/**
 * Pin: the vitest global setup (tests/setup/tmpdir-redirect.ts) points
 * TRIBE_SOCKET at a per-run guard path before any test module loads.
 *
 * Without it, any test-spawned CLI/adapter that resolves a socket with no
 * explicit arg falls through resolveSocketPath()'s env chain to the REAL
 * per-user daemon socket (~/.local/share/tribe/tribe.sock) — the test
 * suite and the live coordination daemon must never share a socket
 * (2026-06-12 daemon-death incident; cause unproven, class closed here).
 *
 * If this pin fires, someone removed the guard from the setup file —
 * restore it there; do NOT scrub the env inside individual tests.
 */

import { describe, expect, it } from "vitest"
import { resolveSocketPath } from "../src/paths.ts"

describe("hermetic socket env", () => {
  it("TRIBE_SOCKET is the per-run guard path, never the real daemon socket", () => {
    const guard = process.env.TRIBE_SOCKET
    expect(guard).toBeDefined()
    expect(guard).toContain("no-real-daemon.sock")
    expect(resolveSocketPath()).toBe(guard)
    expect(resolveSocketPath()).not.toContain(".local/share/tribe")
  })
})
