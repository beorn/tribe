/**
 * @failure Periodic and on-demand health paths diverge, managed mode executes
 *          ps, or exact canonical attribution is discarded before delivery.
 * @level   l2
 * @consumer @hab/21960-hab-sysmon S2 routing cutover
 */

import { describe, expect, it, vi } from "vitest"
import type { CanonicalProcessObservation, HealthProcessSource } from "./health-process-source.ts"
import {
  collectFullMetrics,
  formatCanonicalHealthAlertForDelivery,
  getHealthSnapshot,
  ownerForLockHolder,
} from "./health-monitor-plugin.ts"

function observation(kind: "owned" | "unknown" = "owned"): Extract<CanonicalProcessObservation, { kind: "available" }> {
  return {
    diagnostic: {
      excluded: ["standalone-os-resample", "cross-batch-attribution", "implicit-unowned"],
      location: "/hab/session",
      query: "latest exact process census with owner attribution",
    },
    kind: "available",
    observedAt: 1_000,
    processes: [
      {
        attribution:
          kind === "owned"
            ? { kind: "owned", ownerId: "@dev/3", via: "root" }
            : {
                evidence: { ownerCount: 2, ownerIds: ["@a", "@b"], vias: ["root", "tree"] },
                kind: "unknown",
                reason: "owner-evidence-conflict",
              },
        process: {
          command: "bun worker.ts",
          cpuPercent: 91,
          pgid: 10,
          pid: 10,
          ppid: 1,
          rssBytes: 1_024,
          startTime: "linux:boot:10",
        },
      },
    ],
    schema: "process-observation/1",
    source: { epoch: "host-a", sequence: 7 },
  }
}

function managed(value: CanonicalProcessObservation): HealthProcessSource {
  return { kind: "managed", read: vi.fn(async () => value) }
}

function stubPeripheralCommands() {
  return vi.spyOn(Bun, "spawn").mockImplementation((argv) => {
    const command = Array.isArray(argv) ? argv[0] : ""
    const stdout =
      command === "df"
        ? "Filesystem 1G-blocks Used Available Capacity Mounted_on\n/dev/disk 100 25 75 25% /\n"
        : command === "git"
          ? "/repo branch\n"
          : command === "sh" && Array.isArray(argv) && String(argv[2]).includes("ulimit")
            ? "1024\n"
            : "0\n"
    return {
      exited: Promise.resolve(0),
      stderr: new Response("").body,
      stdout: new Response(stdout).body,
    } as unknown as ReturnType<typeof Bun.spawn>
  })
}

describe("health monitor managed process source", () => {
  it("uses one canonical source for ranking/counting and never spawns ps", async () => {
    const spawn = stubPeripheralCommands()
    const source = managed(observation())

    const result = await collectFullMetrics(source)

    expect(result.metrics.cpu.topProcesses).toEqual([
      expect.objectContaining({ command: "bun worker.ts", cpu: 91, pid: 10 }),
    ])
    expect(result.metrics.bunProcesses).toBe(1)
    expect(result.metrics.processObservation).toEqual({
      kind: "canonical-available",
      observedAt: 1_000,
      source: { epoch: "host-a", sequence: 7 },
    })
    expect(spawn.mock.calls.some(([argv]) => Array.isArray(argv) && argv[0] === "ps")).toBe(false)
    spawn.mockRestore()
  })

  it("keeps managed unavailability explicit in periodic and on-demand snapshots without ps fallback", async () => {
    const unavailable: CanonicalProcessObservation = {
      diagnostic: {
        detail: "journal unreadable",
        excluded: ["standalone-os-resample", "cross-batch-attribution", "implicit-unowned"],
        location: "/hab/session",
        query: "latest exact process census with owner attribution",
      },
      kind: "unavailable",
      reason: "journal-diagnostic",
      schema: "process-observation/1",
    }
    const source = managed(unavailable)
    const spawn = stubPeripheralCommands()

    const periodic = await collectFullMetrics(source)
    const onDemand = await getHealthSnapshot(source)

    expect(periodic.metrics.processObservation).toMatchObject({
      diagnostic: unavailable.diagnostic,
      kind: "canonical-unavailable",
      reason: "journal-diagnostic",
    })
    expect(onDemand.processObservation).toEqual(periodic.metrics.processObservation)
    expect(periodic.metrics.cpu.topProcesses).toEqual([])
    expect(spawn.mock.calls.some(([argv]) => Array.isArray(argv) && argv[0] === "ps")).toBe(false)
    spawn.mockRestore()
  })

  it("does not relabel a managed observation as standalone when unrelated peripheral probes fail", async () => {
    const spawn = vi.spyOn(Bun, "spawn").mockImplementation(() => {
      throw new Error("df unavailable")
    })

    const result = await collectFullMetrics(managed(observation()))

    expect(result.processObservation.kind).toBe("available")
    expect(result.metrics.processObservation.kind).toBe("canonical-available")
    expect(result.metrics.cpu.topProcesses).toEqual([expect.objectContaining({ pid: 10 })])
    expect(spawn.mock.calls.some(([argv]) => Array.isArray(argv) && argv[0] === "ps")).toBe(false)
    spawn.mockRestore()
  })

  it("routes owned alerts and renders unknown evidence from that same observation", () => {
    const alert = {
      message: "CPU warning",
      topOffenders: [{ command: "bun worker.ts", cpu: 91, mem: 0, pid: 10 }],
      type: "cpu" as const,
    }
    expect(formatCanonicalHealthAlertForDelivery(alert, observation())).toMatchObject({
      attributedSessions: new Set(["@dev/3"]),
      hasUnattributed: false,
      message: expect.stringContaining("@dev/3 via=root"),
    })

    const unknown = formatCanonicalHealthAlertForDelivery(alert, observation("unknown"))
    expect(unknown.hasUnattributed).toBe(true)
    expect(unknown.message).toContain("owner-evidence-conflict")
    expect(unknown.message).toContain("owners=@a,@b")
    expect(unknown.message).toContain("via=root,tree")
    expect(unknown.message).toContain("/hab/session")
  })

  it("does not join a freshly observed lock-holder PID to an older canonical incarnation", () => {
    expect(
      ownerForLockHolder(10, observation(), new Map([[10, 1]]), [{ name: "@dev/3", pid: 10, role: "dev" }]),
    ).toBeNull()
  })
})
