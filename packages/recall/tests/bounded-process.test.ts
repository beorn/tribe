/**
 * @failure A timed-out Recall/Tribe command can leave a TERM-ignoring
 *          descendant holding stdout/stderr open, so the caller hangs past
 *          its own deadline or reports a process tree killed when it survived.
 * @level l1
 * @consumer Recall stale-index refresh and Tribe managed health acquisition
 */

import { afterEach, describe, expect, test } from "vitest"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { BoundedProcessCommandError, runBoundedProcessCommand } from "../src/lib/bounded-process.ts"

const scratch: string[] = []
const fixturePids = new Set<number>()

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (errorCode(error) === "ESRCH") return false
    throw error
  }
}

async function waitForFile(path: string, timeoutMs = 2_000): Promise<number> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const pid = Number(readFileSync(path, "utf8").trim())
      if (Number.isSafeInteger(pid) && pid > 1) return pid
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error
    }
    await Bun.sleep(10)
  }
  throw new Error("fixture did not write pid file within " + timeoutMs + "ms: " + path)
}

async function waitDead(pid: number, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true
    await Bun.sleep(10)
  }
  return !pidAlive(pid)
}

afterEach(async () => {
  for (const pid of fixturePids) {
    if (!pidAlive(pid)) continue
    try {
      process.kill(pid, "SIGKILL")
    } catch (error) {
      if (errorCode(error) !== "ESRCH") throw error
    }
    await waitDead(pid)
  }
  fixturePids.clear()
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("runBoundedProcessCommand", () => {
  test("returns exit code and independently captured stdout/stderr", async () => {
    const result = await runBoundedProcessCommand(["sh", "-c", "printf out; printf err >&2; exit 3"], {
      timeoutMs: 5_000,
      killGraceMs: 100,
      reapGraceMs: 500,
      drainGraceMs: 500,
      maxOutputBytes: 64 * 1024,
    })

    expect(result).toEqual({ exitCode: 3, stdout: "out", stderr: "err" })
  })

  test.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
    "TERM-ignoring pipe-holding grandchild dies at the bound and cannot preserve a hang",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "tribe-bounded-process-tree-"))
      scratch.push(dir)
      const childPidFile = join(dir, "child.pid")
      const grandchildPidFile = join(dir, "grandchild.pid")
      const grandchildScript = join(dir, "grandchild.ts")
      const childScript = join(dir, "child.ts")

      writeFileSync(
        grandchildScript,
        [
          'import { writeFileSync } from "node:fs"',
          'process.on("SIGTERM", () => {})',
          "writeFileSync(" + JSON.stringify(grandchildPidFile) + ", String(process.pid))",
          'process.stdout.write("grandchild-ready\\n")',
          "setInterval(() => {}, 1_000)",
        ].join("\n"),
      )
      writeFileSync(
        childScript,
        [
          'import { writeFileSync } from "node:fs"',
          'process.on("SIGTERM", () => {})',
          "writeFileSync(" + JSON.stringify(childPidFile) + ", String(process.pid))",
          "Bun.spawn([" +
            JSON.stringify(process.execPath) +
            ", " +
            JSON.stringify(grandchildScript) +
            '], { stdin: "ignore", stdout: "inherit", stderr: "inherit" })',
          'process.stdout.write("child-ready\\n")',
          "setInterval(() => {}, 1_000)",
        ].join("\n"),
      )

      const started = Date.now()
      const run = runBoundedProcessCommand([process.execPath, childScript], {
        timeoutMs: 150,
        killGraceMs: 150,
        reapGraceMs: 500,
        drainGraceMs: 500,
        maxOutputBytes: 64 * 1024,
      })
      const childPid = await waitForFile(childPidFile)
      const grandchildPid = await waitForFile(grandchildPidFile)
      fixturePids.add(childPid)
      fixturePids.add(grandchildPid)

      const error = await run.catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(BoundedProcessCommandError)
      expect(error).toMatchObject({ failure: { kind: "timeout" } })
      expect((error as Error).message).toContain(JSON.stringify(childScript))
      expect((error as Error).message).toContain("150ms")
      expect((error as Error).message).toContain("SIGKILL")
      expect(Date.now() - started).toBeLessThan(3_000)
      expect(await waitDead(childPid), "direct child survived bounded settlement").toBe(true)
      expect(await waitDead(grandchildPid), "pipe-holding grandchild survived bounded settlement").toBe(true)
    },
    10_000,
  )

  test.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
    "direct exit plus a descendant-held pipe fails loud at the drain bound",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "tribe-bounded-process-drain-"))
      scratch.push(dir)
      const grandchildPidFile = join(dir, "grandchild.pid")
      const childScript = join(dir, "child.ts")
      writeFileSync(
        childScript,
        [
          "const child = Bun.spawn([" +
            JSON.stringify(process.execPath) +
            ', "-e", ' +
            JSON.stringify(
              'import { writeFileSync } from "node:fs"; writeFileSync(' +
                JSON.stringify(grandchildPidFile) +
                ", String(process.pid)); setInterval(() => {}, 1000)",
            ) +
            '], { stdin: "ignore", stdout: "inherit", stderr: "inherit" })',
          'process.stdout.write("parent-exited\\n")',
          "child.unref()",
        ].join("\n"),
      )

      const run = runBoundedProcessCommand([process.execPath, childScript], {
        timeoutMs: 5_000,
        killGraceMs: 100,
        reapGraceMs: 500,
        drainGraceMs: 150,
        maxOutputBytes: 64 * 1024,
      })
      const grandchildPid = await waitForFile(grandchildPidFile)
      fixturePids.add(grandchildPid)

      const error = await run.catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(BoundedProcessCommandError)
      expect(error).toMatchObject({ failure: { kind: "settlement-failed" } })
      expect((error as Error).message).toContain("kept stdout/stderr open")
      expect(await waitDead(grandchildPid), "pipe holder survived drain-bound cleanup").toBe(true)
    },
    10_000,
  )

  test("spawn failure names the command instead of fabricating an exit result", async () => {
    await expect(
      runBoundedProcessCommand(["tribe-no-such-command-cbb0f1"], {
        timeoutMs: 5_000,
        killGraceMs: 100,
        reapGraceMs: 500,
        drainGraceMs: 500,
        maxOutputBytes: 1_024,
      }),
    ).rejects.toMatchObject({
      failure: { kind: "spawn-failed" },
      message: expect.stringContaining('"tribe-no-such-command-cbb0f1"'),
    })
  })

  test.each([
    ["stdout" as const, "head -c 100000 /dev/zero | tr '\\0' x"],
    ["stderr" as const, "head -c 100000 /dev/zero | tr '\\0' x >&2"],
  ])("%s overflow terminates the command and names the stream and byte bound", async (stream, command) => {
    const error = await runBoundedProcessCommand(["sh", "-c", command], {
      timeoutMs: 5_000,
      killGraceMs: 100,
      reapGraceMs: 500,
      drainGraceMs: 500,
      maxOutputBytes: 1_024,
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(BoundedProcessCommandError)
    expect(error).toMatchObject({ failure: { kind: "output-too-large", stream } })
    expect((error as Error).message).toContain(stream + " exceeded 1024 bytes")
  })
})
