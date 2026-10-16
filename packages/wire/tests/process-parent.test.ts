/**
 * @failure A process's parent or start time is read from the wrong /proc/<pid>/stat field when its command name holds
 *          a space or a ')', so a plugin supervisor misjudges which seat it belongs to (29567) or the daemon mistakes a
 *          reused pid for a live one (24604).
 * @level l1
 * @consumer the plugin supervisor's seat-ancestry judgment, recall's process-ancestor walk, the daemon's
 *           readProcessStartTime
 * @testonly ParentPidSources: the fixture /proc root and ps command the reason table points readParentPid at
 *
 * One reader for "the parent of this pid" (@cto 6cbf36b7): /proc/<pid>/stat on Linux, `ps -o ppid=` elsewhere. The
 * stat line parser is shared with the daemon's start-time read, because the error-prone part is the same in both:
 * the fields are counted from the LAST ')' of the command name.
 */

import { spawn, spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { safeRemoveSync } from "removely"
import { describe, expect, test } from "vitest"
import { parseProcStatLine, readParentPid, readParentPidFromPs } from "../src/lib/process-parent.ts"

/** A stat line in the kernel's shape: pid, (comm), then state and fields 4.. ; field 22 is the start time. */
function statLine(comm: string, ppid: number, startTime: string): string {
  const after = ["S", String(ppid), "1", "1", "0", "-1", "4194560", "0", "0", "0", "0", "1", "1", "0", "0", "20", "0"]
  after.push("1", "0", startTime, "1000", "200")
  return `4242 (${comm}) ${after.join(" ")}\n`
}

describe("parseProcStatLine", () => {
  test("reads ppid and start time after a command name holding spaces and parentheses", () => {
    expect(parseProcStatLine(statLine("we) (ird ) name", 1717, "998877"))).toEqual({ ppid: 1717, startTime: "998877" })
  })

  test("a line with no command-name close is not a stat line", () => {
    expect(parseProcStatLine("4242 bun S 1717")).toBeNull()
  })

  test("a line cut short before the start time keeps the parent and has no start time", () => {
    expect(parseProcStatLine("4242 (bun) S 1717 1 1")).toEqual({ ppid: 1717, startTime: null })
  })
})

describe("readParentPid", () => {
  test("this test process's parent is the one the runtime reports", () => {
    expect(readParentPid(process.pid)).toEqual({ ppid: process.ppid })
  })

  test("a live child's parent is this process", () => {
    const child = spawn("sleep", ["5"], { stdio: "ignore" })
    try {
      expect(child.pid).toBeDefined()
      expect(readParentPid(child.pid as number)).toEqual({ ppid: process.pid })
    } finally {
      child.kill("SIGKILL")
    }
  })

  test("a process that has exited has no parent, and the reading says why, never a guess", () => {
    const child = spawnSync("sh", ["-c", "echo $$"], { encoding: "utf8" })
    expect(child.status).toBe(0)
    const pid = Number(child.stdout.trim())
    expect(readParentPid(pid)).toEqual({ ppid: null, reason: `/proc/${pid}/stat is unreadable (ENOENT)` })
  })

  test("a pid that cannot name a process has no parent, by name", () => {
    for (const pid of [0, -1, 1.5, Number.NaN]) {
      expect(readParentPid(pid)).toEqual({ ppid: null, reason: `${pid} is not a process id` })
    }
    expect(readParentPid(2 ** 31)).toEqual({ ppid: null, reason: `/proc/${2 ** 31}/stat is unreadable (ENOENT)` })
  })

  test("the ps fallback agrees with the runtime where ps exists, and names its exit status for a missing pid", () => {
    if (!existsSync("/bin/ps") && !existsSync("/usr/bin/ps")) return
    expect(readParentPidFromPs(process.pid)).toEqual({ ppid: process.ppid })
    expect(readParentPidFromPs(2 ** 31)).toMatchObject({
      ppid: null,
      reason: expect.stringMatching(/^ps exited 1 for pid 2147483648/u),
    })
  })

  // @cto a97214d7 must 4: every reason the reader can give, through readParentPid itself. A fixture /proc root with a
  // self/stat stands for Linux; one without it sends the reader to ps, here a fixture script per reason.
  test("names each of its reasons for reading no parent, one row per reason", () => {
    const root = mkdtempSync(join(tmpdir(), "process-parent-reasons-"))
    try {
      const linux = join(root, "proc-linux")
      mkdirSync(join(linux, "self"), { recursive: true })
      writeFileSync(join(linux, "self", "stat"), "1 (self) S 0\n")
      mkdirSync(join(linux, "4242"))
      writeFileSync(join(linux, "4242", "stat"), "4242 bun S 1717\n")
      const noProc = join(root, "proc-absent")
      mkdirSync(noProc)
      const ps = (name: string, body: string): string => {
        const path = join(root, name)
        writeFileSync(path, `#!/bin/sh\n${body}\n`)
        chmodSync(path, 0o755)
        return path
      }
      const missingPs = join(root, "no-such-ps")
      const rows = [
        { sources: { procRoot: linux, ps: "ps" }, pid: 0, reason: "0 is not a process id" },
        {
          sources: { procRoot: linux, ps: "ps" },
          pid: 4343,
          reason: `${linux}/4343/stat is unreadable (ENOENT)`,
        },
        { sources: { procRoot: linux, ps: "ps" }, pid: 4242, reason: `${linux}/4242/stat has no parent field` },
        { sources: { procRoot: noProc, ps: missingPs }, pid: 4242, reason: "ps could not run (ENOENT)" },
        {
          sources: { procRoot: noProc, ps: ps("ps-slow", "exec sleep 5") },
          pid: 4242,
          reason: "ps timed out after 500 ms",
        },
        {
          sources: { procRoot: noProc, ps: ps("ps-killed", "kill -9 $$") },
          pid: 4242,
          reason: "ps ended on SIGKILL inside its 500 ms bound",
        },
        {
          sources: { procRoot: noProc, ps: ps("ps-exit-3", "echo 'no such pid' >&2; exit 3") },
          pid: 4242,
          reason: "ps exited 3 for pid 4242: no such pid",
        },
        {
          sources: { procRoot: noProc, ps: ps("ps-silent", "exit 0") },
          pid: 4242,
          reason: "ps printed no parent for pid 4242",
        },
      ]
      expect(rows.map((row) => readParentPid(row.pid, row.sources))).toEqual(
        rows.map((row) => ({ ppid: null, reason: row.reason })),
      )
    } finally {
      safeRemoveSync(root, { within: tmpdir() })
    }
  })
})
