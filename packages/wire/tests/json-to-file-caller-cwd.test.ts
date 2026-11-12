/**
 * @failure `@in main -- bun tribe fetch ... --json-to-file wire-x.json` writes wire-x.json into the dev repo root (where @in
 * changed directory), not beside the caller; on 2026-11-06 fifteen such files stalled the shared-main updater for 21
 * minutes (hh issue 33635). Or a process started under @in that later changed directory resolves against a stale caller.
 * @level l1
 * @consumer `tribe fetch | inbox | pending --json-to-file` (writeJsonToFile, jsonDestinationProblem)
 * @testonly none
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { safeRemoveSync } from "removely"
import { afterEach, describe, expect, test, vi } from "vitest"
import { resolveJsonToFilePath, writeJsonToFile } from "../src/cli/json-output.ts"

const dirs: string[] = []
const scratch = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "json-to-file-")))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) safeRemoveSync(dir, { within: realpathSync(tmpdir()), allowMissing: true })
})

describe("a relative --json-to-file path lands beside the caller", () => {
  test("under @in, beside the directory @in was called from", () => {
    const caller = scratch()
    const chosen = scratch()
    expect(resolveJsonToFilePath("wire-x.json", { AT_IN_CALLER_CWD: caller, AT_IN_DIR: chosen }, chosen)).toBe(
      join(caller, "wire-x.json"),
    )
    expect(resolveJsonToFilePath("r50/wire-x.json", { AT_IN_CALLER_CWD: caller, AT_IN_DIR: chosen }, chosen)).toBe(
      join(caller, "r50/wire-x.json"),
    )
  })

  test("an absolute path is unchanged, and with no @in pair a relative one resolves against the process's own cwd", () => {
    const caller = scratch()
    const chosen = scratch()
    expect(resolveJsonToFilePath("/abs/out.json", { AT_IN_CALLER_CWD: caller, AT_IN_DIR: chosen }, chosen)).toBe(
      "/abs/out.json",
    )
    expect(resolveJsonToFilePath("out.json", {}, chosen)).toBe(join(chosen, "out.json"))
  })

  test("a stale pair is ignored: a process that left @in's directory resolves against where it is now", () => {
    const caller = scratch()
    const chosen = scratch()
    const elsewhere = scratch()
    expect(resolveJsonToFilePath("out.json", { AT_IN_CALLER_CWD: caller, AT_IN_DIR: chosen }, elsewhere)).toBe(
      join(elsewhere, "out.json"),
    )
    // A pair naming a directory that no longer exists matches nothing either.
    expect(
      resolveJsonToFilePath("out.json", { AT_IN_CALLER_CWD: caller, AT_IN_DIR: join(chosen, "gone") }, chosen),
    ).toBe(join(chosen, "out.json"))
  })

  test("the file is written beside the caller and the summary names its absolute path", async () => {
    const caller = scratch()
    mkdirSync(join(caller, "r50"))
    vi.stubEnv("AT_IN_CALLER_CWD", caller)
    vi.stubEnv("AT_IN_DIR", realpathSync(process.cwd()))
    const printed: string[] = []
    vi.spyOn(console, "log").mockImplementation((line: string) => void printed.push(line))
    const ok = await writeJsonToFile({ events: [1, 2] }, "r50/wire-x.json", { verb: "fetch", rows: 2, cursor: 7 })
    expect(ok).toBe(true)
    expect(JSON.parse(readFileSync(join(caller, "r50/wire-x.json"), "utf8"))).toEqual({ events: [1, 2] })
    expect(printed).toEqual([`tribe fetch: 2 row(s), cursor 7, written to ${join(caller, "r50/wire-x.json")}`])
  })
})
