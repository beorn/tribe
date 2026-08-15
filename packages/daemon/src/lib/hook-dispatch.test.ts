/**
 * dispatchHook — SessionEnd routes to `cmdSessionEnd` only, and NO event
 * ever reaches `cmdRemember`.
 *
 * `packages/recall/src/lib/hooks.ts`'s `cmdRemember` is a fully-built daily
 * summarization command (`summarizeUnprocessedDays`) that can make a real
 * synchronous LLM call, spawn `git log`, and create retro beads — with no
 * per-day lock against concurrent sessions ending near the same day
 * boundary. Firing it unconditionally from every SessionEnd would risk
 * blocking the hook and racing duplicate summarize/retro-bead work, unlike
 * `cmdSessionEnd`'s cheap detached index refresh. The decision (see the
 * docstring on `cmdRemember` + docs/recall.md § "Automatic injection —
 * hook-driven, not tool-driven") is to keep it manual-only (`recall
 * remember` / `recall summarize`), never hook-dispatched.
 *
 * This test pins that dispatch-table shape at runtime — via a fake recall
 * engine loaded through the `TRIBE_RECALL_ENGINE_DIR` override seam — so a
 * future edit can't silently wire `cmdRemember` back into `dispatchHook()`
 * without a deliberate test update.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { dispatchHook } from "./hook-dispatch.ts"

type HookDispatchTestGlobal = typeof globalThis & { __hookDispatchTestCalls?: string[] }

const calls: string[] = []
;(globalThis as HookDispatchTestGlobal).__hookDispatchTestCalls = calls

let fixtureRoot: string
let prevEngineDir: string | undefined
let prevNoDaemon: string | undefined
let prevDebugLog: string | undefined

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), "tribe-hook-dispatch-fixture-"))
  mkdirSync(join(fixtureRoot, "lib"), { recursive: true })

  // Fake recall engine — records which command dispatchHook() actually
  // invoked, including a `cmdRemember` export the real HookEngine type
  // never names. If dispatchHook ever starts calling it, this array proves
  // it; plain JS so it isn't part of the tsc project (lives under tmpdir,
  // outside tsconfig's include globs) and needs no type-checking.
  writeFileSync(
    join(fixtureRoot, "lib", "hooks.ts"),
    [
      'export async function cmdSessionStart() { globalThis.__hookDispatchTestCalls.push("session-start") }',
      'export async function cmdSessionEnd() { globalThis.__hookDispatchTestCalls.push("session-end") }',
      'export async function cmdHook() { globalThis.__hookDispatchTestCalls.push("hook") }',
      'export async function cmdRemember() { globalThis.__hookDispatchTestCalls.push("remember") }',
      "",
    ].join("\n"),
  )

  prevEngineDir = process.env.TRIBE_RECALL_ENGINE_DIR
  prevNoDaemon = process.env.TRIBE_NO_DAEMON
  prevDebugLog = process.env.INJECTION_DEBUG_LOG
  // Point dispatchHook's lazy engine loader at the fake engine above, keep
  // autostart a no-op (no real daemon probe/spawn side effects), and keep
  // the injection-debug JSONL writer inside the fixture dir instead of the
  // real ~/.local/share/bearly/.
  process.env.TRIBE_RECALL_ENGINE_DIR = fixtureRoot
  process.env.TRIBE_NO_DAEMON = "1"
  process.env.INJECTION_DEBUG_LOG = join(fixtureRoot, "injection.jsonl")
})

afterAll(() => {
  if (prevEngineDir === undefined) delete process.env.TRIBE_RECALL_ENGINE_DIR
  else process.env.TRIBE_RECALL_ENGINE_DIR = prevEngineDir
  if (prevNoDaemon === undefined) delete process.env.TRIBE_NO_DAEMON
  else process.env.TRIBE_NO_DAEMON = prevNoDaemon
  if (prevDebugLog === undefined) delete process.env.INJECTION_DEBUG_LOG
  else process.env.INJECTION_DEBUG_LOG = prevDebugLog
  rmSync(fixtureRoot, { recursive: true, force: true })
})

describe("dispatchHook — cmdRemember stays unreachable (manual-only by design)", () => {
  test("session-end calls cmdSessionEnd only — never cmdRemember", async () => {
    calls.length = 0
    await dispatchHook("session-end")
    expect(calls).toEqual(["session-end"])
  })

  test("session-start calls cmdSessionStart only", async () => {
    calls.length = 0
    await dispatchHook("session-start")
    expect(calls).toEqual(["session-start"])
  })

  test("prompt and pre-compact both route to cmdHook only", async () => {
    calls.length = 0
    await dispatchHook("prompt")
    await dispatchHook("pre-compact")
    expect(calls).toEqual(["hook", "hook"])
  })

  test("no dispatched event, across a full event sweep, ever calls cmdRemember", async () => {
    calls.length = 0
    await dispatchHook("session-start")
    await dispatchHook("prompt")
    await dispatchHook("session-end")
    await dispatchHook("pre-compact")
    expect(calls).not.toContain("remember")
    expect(calls).toEqual(["session-start", "hook", "session-end", "hook"])
  })
})
