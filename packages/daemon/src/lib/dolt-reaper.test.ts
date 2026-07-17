import { describe, expect, it, vi } from "vitest"
import {
  parseLsofCwd,
  isOrphan,
  reapOrphanDoltServers,
  verifyOrphanIncarnation,
  type DoltIncarnationProbe,
} from "./dolt-reaper-plugin.ts"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

describe("parseLsofCwd", () => {
  it("extracts a live cwd path from lsof output", () => {
    // Use a real tmp dir so existsSync returns true.
    const dir = mkdtempSync(join(tmpdir(), "dolt-reaper-test-"))
    try {
      const lsof = [
        "COMMAND   PID  USER   FD   TYPE DEVICE SIZE/OFF    NODE NAME",
        `dolt    12345 user  cwd    DIR    1,16      640 1234567 ${dir}`,
      ].join("\n")
      const info = parseLsofCwd(12345, lsof)
      expect(info.pid).toBe(12345)
      expect(info.cwd).toBe(dir)
      expect(info.cwdExists).toBe(true)
      expect(info.cwdDeletedMarker).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("detects the (deleted) marker", () => {
    const lsof = [
      "COMMAND   PID  USER   FD   TYPE DEVICE SIZE/OFF    NODE NAME",
      "dolt    99999 user  cwd    DIR    1,16      640 1234567 /tmp/gone-long-ago/.beads/dolt (deleted)",
    ].join("\n")
    const info = parseLsofCwd(99999, lsof)
    expect(info.cwd).toBe("/tmp/gone-long-ago/.beads/dolt")
    expect(info.cwdDeletedMarker).toBe(true)
    expect(info.cwdExists).toBe(false) // unlikely to exist on test host
  })

  it("detects cwdExists=false when the path is missing but no (deleted) marker", () => {
    // Some lsof versions don't emit the marker; path-existence still catches it.
    const lsof = [
      "COMMAND   PID  USER   FD   TYPE DEVICE SIZE/OFF    NODE NAME",
      "dolt    77777 user  cwd    DIR    1,16      640 1234567 /absolutely/does/not/exist/dolt",
    ].join("\n")
    const info = parseLsofCwd(77777, lsof)
    expect(info.cwd).toBe("/absolutely/does/not/exist/dolt")
    expect(info.cwdExists).toBe(false)
    expect(info.cwdDeletedMarker).toBe(false)
  })

  it("returns null cwd on malformed output", () => {
    const info = parseLsofCwd(1, "just a garbage line")
    expect(info.cwd).toBeNull()
    expect(info.cwdExists).toBe(false)
  })
})

describe("isOrphan", () => {
  it("orphan when lsof marks (deleted)", () => {
    expect(isOrphan({ pid: 1, cwd: "/gone", cwdExists: false, cwdDeletedMarker: true })).toBe(true)
  })

  it("orphan when cwd path does not exist on disk", () => {
    expect(isOrphan({ pid: 1, cwd: "/does/not/exist", cwdExists: false, cwdDeletedMarker: false })).toBe(true)
  })

  it("NOT orphan when cwd exists and no deleted marker", () => {
    expect(isOrphan({ pid: 1, cwd: "/tmp", cwdExists: true, cwdDeletedMarker: false })).toBe(false)
  })

  it("NOT orphan when cwd couldn't be resolved (safety: don't reap on unknown)", () => {
    expect(isOrphan({ pid: 1, cwd: null, cwdExists: false, cwdDeletedMarker: false })).toBe(false)
  })
})

const ORPHAN = { pid: 4242, cwd: "/gone/.beads/dolt", cwdExists: false, cwdDeletedMarker: true }

function fakeProbe(overrides: Partial<DoltIncarnationProbe> = {}): DoltIncarnationProbe {
  return {
    command: () => "dolt sql-server --port 3306",
    cwd: (pid) => ({ pid, cwd: ORPHAN.cwd, cwdExists: false, cwdDeletedMarker: true }),
    ...overrides,
  }
}

describe("verifyOrphanIncarnation (21441 pid-reuse guard)", () => {
  it("ok when the pid still runs dolt sql-server with the same orphaned cwd", () => {
    expect(verifyOrphanIncarnation(ORPHAN, fakeProbe())).toEqual({ ok: true })
  })

  it("gone when the process exited", () => {
    const verdict = verifyOrphanIncarnation(ORPHAN, fakeProbe({ command: () => null }))
    expect(verdict).toEqual({ ok: false, gone: true, reason: "pid 4242 is gone" })
  })

  it("refuses a recycled pid and names the impostor command", () => {
    const verdict = verifyOrphanIncarnation(ORPHAN, fakeProbe({ command: () => "node /srv/api/server.js" }))
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) {
      expect(verdict.gone).toBe(false)
      expect(verdict.reason).toContain("recycled to 'node /srv/api/server.js'")
    }
  })

  it("refuses when the cwd row is no longer inspectable", () => {
    for (const cwd of [() => null, () => ({ pid: 4242, cwd: null, cwdExists: false, cwdDeletedMarker: false })]) {
      const verdict = verifyOrphanIncarnation(ORPHAN, fakeProbe({ cwd }))
      expect(verdict.ok).toBe(false)
      if (!verdict.ok) expect(verdict.reason).toContain("no longer inspectable")
    }
  })

  it("refuses when the cwd moved to a different path", () => {
    const verdict = verifyOrphanIncarnation(
      ORPHAN,
      fakeProbe({ cwd: (pid) => ({ pid, cwd: "/elsewhere", cwdExists: false, cwdDeletedMarker: true }) }),
    )
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toContain("cwd moved /gone/.beads/dolt -> /elsewhere")
  })

  it("refuses when the same cwd exists again (no longer an orphan)", () => {
    const verdict = verifyOrphanIncarnation(
      ORPHAN,
      fakeProbe({ cwd: (pid) => ({ pid, cwd: ORPHAN.cwd, cwdExists: true, cwdDeletedMarker: false }) }),
    )
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toContain("no longer an orphan")
  })
})

function warnText(warn: ReturnType<typeof vi.spyOn>): string {
  return warn.mock.calls.map((call: unknown[]) => call.join(" ")).join("\n")
}

describe("reapOrphanDoltServers (injected effects)", () => {
  it("SIGTERMs a verified orphan and SIGKILLs it after the grace when still alive", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const kills: Array<[number, string]> = []
      let escalate: (() => void) | undefined
      const result = reapOrphanDoltServers({
        inspect: () => [ORPHAN],
        probe: fakeProbe(),
        kill: (pid, signal) => {
          kills.push([pid, signal])
        },
        scheduleEscalation: (fn) => {
          escalate = fn
        },
      })

      expect(result).toEqual({ scanned: 1, orphans: 1, killed: 1, skipped: 0 })
      expect(kills).toEqual([[4242, "SIGTERM"]])
      expect(escalate).toBeDefined()
      escalate?.()
      expect(kills).toEqual([
        [4242, "SIGTERM"],
        [4242, "SIGKILL"],
      ])
      expect(warnText(warn)).toContain("SIGKILL dolt that survived SIGTERM pid=4242")
    } finally {
      warn.mockRestore()
    }
  })

  it("never signals a pid whose incarnation check refuses — and says so loudly", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const kills: Array<[number, string]> = []
      const result = reapOrphanDoltServers({
        inspect: () => [ORPHAN],
        probe: fakeProbe({ command: () => "node /srv/api/server.js" }),
        kill: (pid, signal) => {
          kills.push([pid, signal])
        },
        scheduleEscalation: () => {
          throw new Error("no escalation should be scheduled when nothing was TERMed")
        },
      })

      expect(result).toEqual({ scanned: 1, orphans: 1, killed: 0, skipped: 1 })
      expect(kills).toEqual([])
      expect(warnText(warn)).toContain("skip reap: pid 4242 was recycled to 'node /srv/api/server.js'")
    } finally {
      warn.mockRestore()
    }
  })

  it("skips the SIGKILL escalation for a pid recycled during the grace window — and says so loudly", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const kills: Array<[number, string]> = []
      let escalate: (() => void) | undefined
      let commandNow = "dolt sql-server --port 3306"
      const probe = fakeProbe({ command: () => commandNow })

      reapOrphanDoltServers({
        inspect: () => [ORPHAN],
        probe,
        kill: (pid, signal) => {
          kills.push([pid, signal])
        },
        scheduleEscalation: (fn) => {
          escalate = fn
        },
      })
      expect(kills).toEqual([[4242, "SIGTERM"]])

      commandNow = "cc1plus important-build.o"
      escalate?.()
      expect(kills).toEqual([[4242, "SIGTERM"]])
      expect(warnText(warn)).toContain("skip SIGKILL: pid 4242 was recycled to 'cc1plus important-build.o'")
    } finally {
      warn.mockRestore()
    }
  })

  it("skips the SIGKILL escalation when SIGTERM already killed the orphan", () => {
    const kills: Array<[number, string]> = []
    let escalate: (() => void) | undefined
    let alive = true
    const probe = fakeProbe({ command: () => (alive ? "dolt sql-server --port 3306" : null) })

    reapOrphanDoltServers({
      inspect: () => [ORPHAN],
      probe,
      kill: (pid, signal) => {
        kills.push([pid, signal])
      },
      scheduleEscalation: (fn) => {
        escalate = fn
      },
    })
    expect(kills).toEqual([[4242, "SIGTERM"]])

    alive = false
    escalate?.()
    expect(kills).toEqual([[4242, "SIGTERM"]])
  })

  it("counts a kill() refusal (ESRCH-style throw) as not killed", () => {
    const result = reapOrphanDoltServers({
      inspect: () => [ORPHAN],
      probe: fakeProbe(),
      kill: () => {
        throw new Error("kill ESRCH")
      },
      scheduleEscalation: () => {
        throw new Error("nothing TERMed — no escalation")
      },
    })
    expect(result).toEqual({ scanned: 1, orphans: 1, killed: 0, skipped: 0 })
  })
})
