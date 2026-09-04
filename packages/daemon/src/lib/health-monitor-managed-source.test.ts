/**
 * @failure Periodic and on-demand health paths diverge, managed mode executes
 *          ps, or exact canonical attribution is discarded before delivery.
 * @level   l2
 * @consumer @hab/21960-hab-sysmon S2 routing cutover
 */

import { describe, expect, it, vi } from "vitest"
import type {
  CanonicalHostScalarObservation,
  CanonicalProcessObservation,
  HealthProcessSource,
} from "./health-process-source.ts"
import {
  collectFullMetrics,
  createAlertState,
  defaultThresholds,
  evaluateAlerts,
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

function managed(
  value: CanonicalProcessObservation,
  scalars: CanonicalHostScalarObservation = scalarObservation(),
): HealthProcessSource {
  return { kind: "managed", read: vi.fn(async () => value), readScalars: vi.fn(async () => scalars) }
}

function scalarObservation(): Extract<CanonicalHostScalarObservation, { kind: "available" }> {
  return {
    kind: "available",
    observedAt: 1_500,
    schema: "host-scalar-observation/1",
    source: { epoch: "host-a", sequence: 8 },
    values: {
      cpu: {
        kind: "supported",
        value: { busyPercent: 25, loadAverage1m: 1.25, loadAverage5m: 1, loadAverage15m: 0.75, logicalCores: 8 },
      },
      disk: {
        kind: "supported",
        value: {
          availableBytes: 6 * 1024 ** 3,
          freeBytes: 6 * 1024 ** 3,
          inodes: { kind: "supported", value: { free: 600, total: 1_000, used: 400 } },
          path: "/tmp",
          totalBytes: 10 * 1024 ** 3,
          usedBytes: 4 * 1024 ** 3,
        },
      },
      diskIo: { kind: "supported", value: { readWriteBytesPerSecond: 2 * 1024 ** 2 } },
      kind: "host:scalars",
      memory: {
        kind: "supported",
        value: { availableBytes: 6 * 1024 ** 3, totalBytes: 10 * 1024 ** 3, usedBytes: 4 * 1024 ** 3 },
      },
      sampleBudgetMs: 250,
      sampleDurationMs: 4,
      sampleOverBudget: false,
      swap: {
        kind: "supported",
        value: { freeBytes: 924 * 1024 ** 2, totalBytes: 1024 * 1024 ** 2, usedBytes: 100 * 1024 ** 2 },
      },
    },
  }
}

function stubPeripheralCommands() {
  return vi.spyOn(Bun, "spawn").mockImplementation((argv) => {
    const command = Array.isArray(argv) ? argv[0] : ""
    const stdout =
      command === "git"
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
  it("maps canonical host scalars and never invokes standalone OS acquisition", async () => {
    const spawn = stubPeripheralCommands()
    const osSampler = vi.fn(() => {
      throw new Error("standalone OS sampler must not run")
    })

    const result = await collectFullMetrics(managed(observation()), { collectOsMetrics: osSampler })

    expect(osSampler).not.toHaveBeenCalled()
    expect(result.metrics).toMatchObject({
      cpu: { coreCount: 8, loadAvg1m: 1.25, loadAvg5m: 1 },
      disk: {
        availableBytes: 6 * 1024 ** 3,
        freeBytes: 6 * 1024 ** 3,
        inodes: { kind: "supported", value: { free: 600, total: 1_000, used: 400 } },
        path: "/tmp",
        totalBytes: 10 * 1024 ** 3,
        usedBytes: 4 * 1024 ** 3,
      },
      diskIo: { readWriteMBps: 2 },
      memory: { availableMB: 6_144, pressurePercent: 40, swapUsedMB: 100, totalMB: 10_240, usedMB: 4_096 },
      scalarObservation: {
        kind: "canonical-available",
        observedAt: 1_500,
        source: { epoch: "host-a", sequence: 8 },
      },
      timestamp: 1_500,
    })
    expect(
      spawn.mock.calls.some(
        ([argv]) => Array.isArray(argv) && ["df", "iostat", "ps", "sh", "sysctl", "vm_stat"].includes(String(argv[0])),
      ),
    ).toBe(false)
    spawn.mockRestore()
  })

  it("keeps the legacy OS sampler live only for standalone mode", async () => {
    const spawn = stubPeripheralCommands()
    const osSampler = vi.fn(() => ({
      cpu: { coreCount: 4, loadAvg1m: 2, loadAvg5m: 1 },
      memory: { availableMB: 750, pressurePercent: 25, swapUsedMB: 0, totalMB: 1_000, usedMB: 250 },
      timestamp: 9_000,
    }))

    const result = await collectFullMetrics({ kind: "standalone-os" }, { collectOsMetrics: osSampler })

    expect(osSampler).toHaveBeenCalledOnce()
    expect(result.metrics).toMatchObject({
      cpu: { coreCount: 4, loadAvg1m: 2, loadAvg5m: 1 },
      memory: { availableMB: 750, pressurePercent: 25, totalMB: 1_000, usedMB: 250 },
      scalarObservation: { kind: "standalone-os" },
      timestamp: 9_000,
    })
    expect(spawn.mock.calls.some(([argv]) => Array.isArray(argv) && argv[0] === "df")).toBe(false)
    expect(
      spawn.mock.calls.some(
        ([argv]) => Array.isArray(argv) && argv.some((part) => /ulimit|lsof -n/.test(String(part))),
      ),
    ).toBe(false)
    expect(result.metrics).not.toHaveProperty("fdCount")
    // The old detector compared a global row count with one process's limit.
    // Neither the real 45 descriptors nor the misreported 388,759 may page.
    for (const total of [45, 388_759]) {
      const legacyMetrics = { ...result.metrics, fdCount: { total, limit: 524_288, perSession: [] } }
      const types = evaluateAlerts(legacyMetrics, defaultThresholds(), createAlertState()).map((alert) => alert.type)
      expect(types).not.toContain("fd-count")
    }
    spawn.mockRestore()
  })

  it("names missing inode evidence when replaying a historical byte-only reading", async () => {
    const scalars = structuredClone(scalarObservation())
    if (scalars.values.disk.kind !== "supported") throw new Error("expected supported disk fixture")
    delete (scalars.values.disk.value as { inodes?: unknown }).inodes

    const { metrics } = await collectFullMetrics(managed(observation(), scalars))

    expect(metrics.disk).toMatchObject({ path: "/tmp", usedBytes: 4 * 1024 ** 3 })
    expect(metrics.scalarObservation).toMatchObject({ unavailable: ["disk.inodes"] })
  })

  it("treats 98 percent inodes as critical while bytes are only 62 percent used", async () => {
    const base = scalarObservation()
    if (base.values.disk.kind !== "supported") throw new Error("fixture disk must be supported")
    const scalars: CanonicalHostScalarObservation = {
      ...base,
      values: {
        ...base.values,
        disk: {
          kind: "supported",
          value: {
            ...base.values.disk.value,
            availableBytes: 38,
            freeBytes: 38,
            inodes: { kind: "supported", value: { free: 20, total: 1_000, used: 980 } },
            totalBytes: 100,
            usedBytes: 62,
          },
        },
      },
    }
    const spawn = stubPeripheralCommands()
    const { metrics } = await collectFullMetrics(managed(observation(), scalars))
    const alerts = evaluateAlerts(metrics, defaultThresholds(), createAlertState())

    expect(metrics.disk).toMatchObject({
      inodes: { kind: "supported", value: { used: 980 } },
      path: "/tmp",
      totalBytes: 100,
      usedBytes: 62,
    })
    expect(alerts).toEqual([
      expect.objectContaining({
        message: expect.stringMatching(/\/tmp.*98% inodes.*62% bytes.*root filesystem not covered/i),
        severity: "critical",
        type: "disk",
      }),
    ])
    spawn.mockRestore()
  })

  it("keeps managed scalar unavailability explicit without any OS fallback", async () => {
    const spawn = stubPeripheralCommands()
    const osSampler = vi.fn(() => {
      throw new Error("standalone OS sampler must not run")
    })
    const unavailable: CanonicalHostScalarObservation = {
      detail: "scalar journal stale",
      kind: "unavailable",
      reason: "scalar-fact-stale",
      schema: "host-scalar-observation/1",
    }

    const result = await collectFullMetrics(managed(observation(), unavailable), { collectOsMetrics: osSampler })

    expect(osSampler).not.toHaveBeenCalled()
    expect(result.metrics.cpu).toEqual({
      topProcesses: [expect.objectContaining({ command: "bun worker.ts", pid: 10 })],
    })
    expect(result.metrics.memory).toBeUndefined()
    expect(result.metrics.disk).toBeUndefined()
    expect(result.metrics.diskIo).toBeUndefined()
    expect(result.metrics.scalarObservation).toEqual({
      detail: "scalar journal stale",
      kind: "canonical-unavailable",
      reason: "scalar-fact-stale",
    })
    expect(
      spawn.mock.calls.some(
        ([argv]) => Array.isArray(argv) && ["df", "iostat", "ps", "sh", "sysctl", "vm_stat"].includes(String(argv[0])),
      ),
    ).toBe(false)
    spawn.mockRestore()
  })

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
