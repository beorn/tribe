/**
 * safe-reload gate — reusable admission helpers (@ag/tribe/20703 safe-reload-gate).
 *
 * The doctrine: watch-triggered hot-reload STAYS, but a reload must never
 * replace a working daemon with a broken one, and must be observable. These
 * tests pin the two reusable primitives that make that true, independent of
 * any daemon wiring so the stdio-adapter can adopt them in a follow-up:
 *
 *   1. createReloadDebouncer — N source-change events inside a window coalesce
 *      into exactly ONE reload (a 50-file gitlink bump must not fire 50 — nor
 *      the 2 that today's log shows).
 *   2. runAdmissionPrecheck — spawn the candidate entry with the precheck flag;
 *      a broken source tree exits non-zero (module graph fails to load) and the
 *      caller can refuse the re-exec; a good tree exits 0.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createReloadDebouncer, runAdmissionPrecheck } from "../src/lib/hot-reload.ts"

describe("createReloadDebouncer", () => {
  it("coalesces a burst of triggers within the window into ONE flush", async () => {
    let flushes = 0
    const d = createReloadDebouncer({ windowMs: 30, onFlush: () => flushes++ })
    // Simulate a gitlink bump touching 50 files: 50 change events back-to-back.
    for (let i = 0; i < 50; i++) d.trigger()
    expect(d.pending).toBe(true)
    expect(flushes).toBe(0) // nothing yet — still inside the window
    await new Promise((r) => setTimeout(r, 60))
    expect(flushes).toBe(1)
    expect(d.pending).toBe(false)
    d[Symbol.dispose]()
  })

  it("re-arms after a flush so a later change reloads again", async () => {
    let flushes = 0
    const d = createReloadDebouncer({ windowMs: 20, onFlush: () => flushes++ })
    d.trigger()
    await new Promise((r) => setTimeout(r, 40))
    expect(flushes).toBe(1)
    d.trigger()
    await new Promise((r) => setTimeout(r, 40))
    expect(flushes).toBe(2)
    d[Symbol.dispose]()
  })

  it("dispose cancels a pending flush", async () => {
    let flushes = 0
    const d = createReloadDebouncer({ windowMs: 20, onFlush: () => flushes++ })
    d.trigger()
    expect(d.pending).toBe(true)
    d[Symbol.dispose]()
    await new Promise((r) => setTimeout(r, 40))
    expect(flushes).toBe(0)
  })
})

describe("runAdmissionPrecheck", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tribe-precheck-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("accepts a good candidate (exits 0 on the precheck flag)", async () => {
    const entry = join(dir, "good.ts")
    writeFileSync(
      entry,
      `if (process.argv.includes("--precheck")) { process.exit(0) }\n// would otherwise open a DB / bind a socket here\nprocess.exit(7)\n`,
    )
    const res = await runAdmissionPrecheck({ entry, timeoutMs: 15_000 })
    expect(res.ok).toBe(true)
    expect(res.code).toBe(0)
    expect(res.timedOut).toBe(false)
  })

  it("rejects a candidate with a syntax error (module graph fails to load)", async () => {
    const entry = join(dir, "broken.ts")
    // A genuine parse error — bun cannot load the module graph at all.
    writeFileSync(entry, `const = = = not valid typescript {{{\n`)
    const res = await runAdmissionPrecheck({ entry, timeoutMs: 15_000 })
    expect(res.ok).toBe(false)
    expect(res.code).not.toBe(0)
    expect(res.stderr.length).toBeGreaterThan(0)
  })

  it("rejects a candidate whose precheck exits non-zero", async () => {
    const entry = join(dir, "nonzero.ts")
    writeFileSync(entry, `if (process.argv.includes("--precheck")) { process.exit(3) }\nprocess.exit(0)\n`)
    const res = await runAdmissionPrecheck({ entry, timeoutMs: 15_000 })
    expect(res.ok).toBe(false)
    expect(res.code).toBe(3)
  })

  it("rejects (does not hang) a candidate that never exits — times out and kills it", async () => {
    const entry = join(dir, "hang.ts")
    writeFileSync(entry, `await new Promise(() => {})\n`)
    const res = await runAdmissionPrecheck({ entry, timeoutMs: 300 })
    expect(res.ok).toBe(false)
    expect(res.timedOut).toBe(true)
  })
})
