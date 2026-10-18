/**
 * @failure A timed-out Recall/Tribe command can leave a TERM-ignoring
 *          descendant holding stdout/stderr open, so the caller hangs past
 *          its own deadline or reports a process tree killed when it survived.
 * @level l1
 * @consumer Recall stale-index refresh and Tribe managed health acquisition
 */

import { afterEach, describe, expect, test, vi } from "vitest"
import { connect, createServer } from "node:net"
import * as processStat from "tribe-wire/lib/process-parent"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  BoundedProcessCommandError,
  runBoundedProcessCommand,
  type ReadBoundedProcessCompletion,
  type BoundedProcessCompletion,
} from "../src/lib/bounded-process.ts"

const scratch: string[] = []
const fixturePids = new Set<number>()

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined
}

/**
 * Whether `pid` is still RUNNING. These tests assert a process tree DIED, and a
 * zombie has: it is dead, unreaped, and can never run again, yet it still
 * answers `kill(pid, 0)`. Asking only that made a teardown that finishes in
 * milliseconds read as a survivor for as long as its parent took to reap it,
 * so these tests failed whenever reaping lagged. This is not a relaxation: the
 * bounds and assertions are unchanged; only a corpse now reads as dead.
 *
 * Existence stays the portable probe. On Linux, /proc says whether an existing
 * pid is a corpse (state Z) or already gone; anything else unreadable keeps the
 * portable answer, so a death is never certified on missing evidence.
 */
function pidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch (error) {
    if (errorCode(error) === "ESRCH") return false
    throw error
  }
  if (process.platform !== "linux") return true
  let stat: string
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8")
  } catch (error) {
    // It exited between the two reads.
    if (errorCode(error) === "ENOENT") return false
    return true
  }
  // The state follows the parenthesised command name, which may itself contain ")".
  return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z"
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
    if (!pidRunning(pid)) return true
    await Bun.sleep(10)
  }
  return !pidRunning(pid)
}

afterEach(async () => {
  for (const pid of fixturePids) {
    if (!pidRunning(pid)) continue
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
  /** @failure Missing trusted state or a recycled pid is converted into exit, leaving the real owned child alive.
   * @level l2 @consumer Every bounded command's conservative timeout settlement. No test-only production seam. */
  test.skipIf(process.platform !== "linux").each(["unavailable", "recycled"] as const)(
    "%s completion remains unknown and terminates the owned child",
    async (arm) => {
      const original = processStat.readProcessStat
      let pid: number | undefined
      let birth: processStat.ProcessStatReading | undefined
      const reader = vi.spyOn(processStat, "readProcessStat").mockImplementation((value, root) => {
        if (pid === undefined) {
          pid = value
          birth = original(value, root)
          return birth
        }
        if (value !== pid) return original(value, root)
        if (arm === "unavailable") {
          return { kind: "unavailable", reason: `/proc/${value}/stat fixture unreadable (EACCES)` }
        }
        if (birth === undefined || !("fields" in birth) || birth.fields.startTime === null) {
          throw new Error("fixture birth unavailable")
        }
        return { kind: "live", fields: { ...birth.fields, startTime: String(BigInt(birth.fields.startTime) + 1n) } }
      })
      try {
        const result = await runBoundedProcessCommand(["/bin/sh", "-c", "exec sleep 5"], {
          timeoutMs: 100,
          killGraceMs: 100,
          reapGraceMs: 500,
          drainGraceMs: 500,
          maxOutputBytes: 1024,
        }).catch((error: unknown) => error)
        expect(result).toBeInstanceOf(BoundedProcessCommandError)
        expect(result).toMatchObject({
          failure: { kind: "timeout" },
          message: expect.stringContaining(`completion arm unknown/${arm}`),
        })
        expect(pid).toBeTypeOf("number")
        expect(await waitDead(pid!)).toBe(true)
      } finally {
        reader.mockRestore()
      }
    },
  )

  /** @failure A child already exited before the delayed execution timer is called hung and killed (30030 slice3).
   * @level l2 @consumer Identity verifier and every captured command sharing this bounded owner.
   * Deferred promises do not reproduce Bun/Linux poll ordering; observe the actual execution timer unchanged. */
  test.skipIf(process.platform !== "linux" || process.versions.bun === undefined)(
    "consumes the existing exit and output when the execution timeout callback witnesses a zombie",
    async () => {
      const original = globalThis.setTimeout
      let read: ReadBoundedProcessCompletion | undefined
      let atTimeout: BoundedProcessCompletion | undefined
      const timeout = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
        fn: (...args: unknown[]) => void,
        ms: number,
        ...args: unknown[]
      ) =>
        original(() => {
          if (ms === 100 && atTimeout === undefined) atTimeout = read?.()
          fn(...args)
        }, ms)) as typeof setTimeout)
      const answer = Promise.withResolvers<unknown>()
      const server = createServer((socket) =>
        socket.once("data", () => {
          const pending = runBoundedProcessCommand(
            ["/bin/sh", "-c", "printf result; exit 3"],
            { timeoutMs: 100, killGraceMs: 100, reapGraceMs: 500, drainGraceMs: 500, maxOutputBytes: 1024 },
            {
              trackCompletion: (value) => {
                read = value
              },
            },
          )
          // Socket poll callback stalls JS dispatch across the execution bound, while the real child exits.
          const until = performance.now() + 250
          while (performance.now() < until) {}
          socket.end()
          void pending.then(answer.resolve, (error) => answer.resolve(error))
        }),
      )
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
      const address = server.address()
      if (address === null || typeof address === "string") throw new Error("test socket has no TCP address")
      const client = connect(address.port, "127.0.0.1", () => client.write("probe"))
      try {
        const result = await answer.promise
        expect(
          atTimeout,
          `Bun ${process.versions.bun}: actual callback must observe the demonstrated zombie order`,
        ).toEqual({ state: "exited", evidence: "zombie" })
        expect(result).toEqual({ exitCode: 3, stdout: "result", stderr: "" })
      } finally {
        timeout.mockRestore()
        client.destroy()
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    },
    10_000,
  )

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
