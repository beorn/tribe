/**
 * @failure  A process whose mmap lock is held pins a /proc read in habmod's census forever, and nothing tells anyone
 *           which process it is: the census just stays incomplete (24248, @cto 0fb300a3).
 * @level    l1
 * @consumer the proc-read-pinned incident @chief receives from the health monitor
 * @testonly none
 */

import { describe, expect, it } from "vitest"
import {
  checkPinnedProcReads,
  PROC_READ_PINNED_AFTER_MS,
  PROC_READ_PINNED_CONDITION,
  PROC_READ_PINNED_EMITTER,
  PROC_READ_PINNED_OWNER,
} from "./health-monitor-plugin.ts"
import { createHealthProcessSource, type CanonicalProcessObservation } from "./health-process-source.ts"

const diagnostic = {
  excluded: ["standalone-os-resample", "cross-batch-attribution", "implicit-unowned"],
  location: "/hab/habmod",
  query: "latest exact process census with owner attribution",
}
const since = "2026-09-24T12:00:00.000Z"
const sinceMs = Date.parse(since)
const read = { path: "/proc/80/environ", pid: 80, since, startTime: "linux:boot-a:4242" }

function incomplete(reads: readonly (typeof read)[]): CanonicalProcessObservation {
  return {
    diagnostic: { ...diagnostic, detail: "error on 1 rows" },
    kind: "unavailable",
    pendingProcReads: { budget: 16, reads },
    reason: "process-census-incomplete",
    schema: "process-observation/1",
  }
}

describe("the snapshot's pending /proc reads reach the monitor (24248)", () => {
  const readPayload = async (payload: unknown) => {
    const source = createHealthProcessSource({
      env: { HAB_SERVICE_KIND: "service", HAB_SESSION_DIR: "/hab/tribe" },
      runCommand: async () => ({ exitCode: 0, stderr: "", stdout: `${JSON.stringify(payload)}\n` }),
    })
    if (source.kind !== "managed") throw new Error("expected managed source")
    return source.read()
  }

  it("keeps the additive field on an unavailable observation", async () => {
    await expect(readPayload(incomplete([read]))).resolves.toMatchObject({
      pendingProcReads: { budget: 16, reads: [read] },
      reason: "process-census-incomplete",
    })
  })

  it("refuses a malformed pending read rather than aging a fabricated one", async () => {
    const result = await readPayload(incomplete([{ ...read, since: "not a time" }]))
    expect(result).toMatchObject({ kind: "unavailable" })
    expect(result.kind === "unavailable" ? result.reason : "").not.toBe("process-census-incomplete")
  })
})

describe("a pinned /proc read raises one incident per process incarnation (24248)", () => {
  const subject = "80:linux:boot-a:4242"
  const incident = { condition: PROC_READ_PINNED_CONDITION, emitter: PROC_READ_PINNED_EMITTER, subject }

  it("raises once, to @chief, naming pid, path, since and the cure, when the read is older than five minutes", () => {
    const told = new Map<string, string>()
    const actions = checkPinnedProcReads(incomplete([read]), sinceMs + PROC_READ_PINNED_AFTER_MS, [], told)

    expect(actions).toEqual([
      {
        content: expect.stringContaining(
          "This process is blocking /proc reads of its own cmdline or environ; find it with `hab sysmon snapshot` " +
            "and kill or fix it.",
        ),
        incident,
        kind: "raise",
        recipient: PROC_READ_PINNED_OWNER,
        summary: `pid 80 has held a /proc read pending since ${since}: /proc/80/environ`,
      },
    ])
  })

  it("does not re-raise while the condition line is unchanged", () => {
    const told = new Map<string, string>()
    checkPinnedProcReads(incomplete([read]), sinceMs + PROC_READ_PINNED_AFTER_MS, [], told)
    const open = [{ recipient: PROC_READ_PINNED_OWNER, subject }]

    expect(checkPinnedProcReads(incomplete([read]), sinceMs + 2 * PROC_READ_PINNED_AFTER_MS, open, told)).toEqual([])
  })

  it("upserts when a second read of the same process pins, since the condition line changed", () => {
    const told = new Map<string, string>()
    checkPinnedProcReads(incomplete([read]), sinceMs + PROC_READ_PINNED_AFTER_MS, [], told)
    const open = [{ recipient: PROC_READ_PINNED_OWNER, subject }]
    const status = { ...read, path: "/proc/80/status", since: "2026-09-24T12:01:00.000Z" }

    expect(
      checkPinnedProcReads(incomplete([read, status]), sinceMs + 2 * PROC_READ_PINNED_AFTER_MS, open, told),
    ).toMatchObject([
      {
        kind: "raise",
        summary: `pid 80 has held a /proc read pending since ${since}: /proc/80/environ, /proc/80/status`,
      },
    ])
  })

  it("clears when a later census no longer reports the read", () => {
    const open = [{ recipient: PROC_READ_PINNED_OWNER, subject }]

    expect(checkPinnedProcReads(incomplete([]), sinceMs + 2 * PROC_READ_PINNED_AFTER_MS, open, new Map())).toEqual([
      {
        content: "cleared: pid 80's /proc read settled or the process is gone",
        incident,
        kind: "clear",
        recipient: PROC_READ_PINNED_OWNER,
        summary: "cleared: pid 80's /proc read settled or the process is gone",
      },
    ])
  })

  it("raises nothing for a read younger than the threshold", () => {
    expect(checkPinnedProcReads(incomplete([read]), sinceMs + PROC_READ_PINNED_AFTER_MS - 1, [], new Map())).toEqual([])
  })

  it("changes nothing when the snapshot itself failed, since that says nothing about the read", () => {
    const open = [{ recipient: PROC_READ_PINNED_OWNER, subject }]
    const failed: CanonicalProcessObservation = {
      diagnostic,
      kind: "unavailable",
      reason: "source-command-timeout",
      schema: "process-observation/1",
    }

    expect(checkPinnedProcReads(failed, sinceMs + 2 * PROC_READ_PINNED_AFTER_MS, open, new Map())).toEqual([])
  })
})
