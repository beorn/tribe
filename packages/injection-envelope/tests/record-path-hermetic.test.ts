/**
 * @failure A test emits a row without naming a record path, so the writer installs a second writer on the REAL
 *          per-user record (~/.local/share/bearly/injection.jsonl) beside the scratch writer the test asserted on.
 *          That wrote tens of MiB of fixture rows per run into the operator's record; once the writer's bound landed
 *          it became destruction, because the writer rotates what it cannot bound — on 2026-10-16 one run of
 *          record-bound.test.ts rotated the real 251,832,256 B record aside as `<path>.1` and that run's next 32 MiB
 *          replaced it. The TRIBE suite's own vitest setup (tests/setup/tmpdir-redirect.ts) now pins
 *          INJECTION_DEBUG_LOG at a per-process guard path before any test module loads; this pin is what makes its
 *          removal loud.
 * @level l2 — the real fallback resolution and the real loggily writer, against the setup's own guard path
 * @consumer @ag/hab/29681-every-log-writer-goes-through/bound-the-tribe-injection-record
 * @reach fs-walk <fixture-only: the per-process guard path the setup file names under the test tmp base>
 * @testonly none
 *
 * If this pin fires, someone removed the guard from tests/setup/tmpdir-redirect.ts — restore it there; do NOT scrub
 * the env inside individual tests, which is what left the fallback live in every file that emitted a row.
 *
 * SKIPPED when the ROOT suite owns the run (`bun fix`, `test:full`): that config defines its own `vendor` project and
 * does not load the tribe setup files at all, and it pins HOME to a guard home before any fork instead
 * (@i/17-test-system/25231, ag/packages/hab-core/src/test-support/test-home-guard.ts), so the per-user fallback
 * already resolves inside that guard home and there is no live fallback here to pin. Skipped loudly rather than
 * weakened: the assertion below is about the tribe setup, and a version of it that passes under both configs would
 * be asserting nothing.
 */

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { setLogLevel, setSuppressConsole } from "loggily"
import { describe, expect, it } from "vitest"
import { emitInjectionDebugEvent, flushInjectionFileWriters } from "../src/debug.ts"

/** The base the tribe setup redirects TMPDIR to; only that setup sets it. */
const TRIBE_TMP_BASE = `/tmp/tribe-vitest-${process.getuid?.() ?? 0}`

describe.skipIf(process.env.TMPDIR !== TRIBE_TMP_BASE)("hermetic injection record", () => {
  it("the fallback is the guard path the setup pinned, not the real per-user record", () => {
    const guard = process.env.INJECTION_DEBUG_LOG
    expect(guard, "tests/setup/tmpdir-redirect.ts must pin INJECTION_DEBUG_LOG").toBeDefined()
    expect(guard).toContain("injection-record-guard")
    expect(guard, "the fallback resolves to a real per-user record path").not.toBe(
      join(homedir(), ".local", "share", "bearly", "injection.jsonl"),
    )
  })

  it("a row emitted with no explicit writer lands in the guard path", () => {
    const guard = process.env.INJECTION_DEBUG_LOG
    expect(guard).toBeDefined()
    // The record's sink IS a loggily writer, so the level decides whether the row reaches it at all.
    setSuppressConsole(true)
    setLogLevel("info")
    emitInjectionDebugEvent({ source: "recall", action: "skip", reason: "hermetic-record-pin" })
    flushInjectionFileWriters()
    expect(readFileSync(guard!, "utf8"), "the row did not reach the guard path").toContain("hermetic-record-pin")
  })
})
