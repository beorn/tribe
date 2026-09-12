/**
 * @failure The disk threshold could not fire on this host at all. `metrics.disk`
 *          is typed against the canonical host-scalar lane, and that lane is
 *          carrying nothing: `hab sysmon snapshot --kind scalars` returns
 *          `scalar-fact-unavailable` for both kinds, which is an EMPTY JOURNAL.
 *          The writer landed (ag `1917be42b3`); the daemon serving these metrics
 *          predates it, carries no journal dir, and is reparented to init, so no
 *          supervisor will restart it into the fix — the relaunch is a deferred
 *          wire break held by `@chief` (@i/4-supervision/24248). So the field was
 *          never populated, and on 2026-09-07 a 61G RAM-backed tmpfs passed the
 *          85% warning line and took four seats' shells with it, unannounced.
 *          `@i/4-supervision/24233`.
 * @level   l2 — the real exported `readDiskCapacityDirect`, `collectFullMetrics`
 *          and `evaluateAlerts`, with `statfs` injected. Only the syscall is a
 *          stub, because the contract under test is what the production
 *          evaluator EMITS from a given filesystem reading.
 * @consumer @chief, who reads the host-health broadcast for runtime health, and
 *           every seat whose shell dies when the shared tmpfs fills.
 *
 * The mutation matrix, all run and all RED before the arms below were accepted:
 *
 * | mutation                                              | arms that go RED                  |
 * | ----------------------------------------------------- | --------------------------------- |
 * | `bfree` used where `bavail` belongs                    | maps a reading                    |
 * | the `catch` returns a zero-usage capacity              | an unreadable mount; blindness    |
 * | the `totalBytes <= 0` guard deleted                    | a filesystem claiming no size     |
 * | the inode branch omits `inodes` instead of naming it   | a mount with no inode table       |
 * | the seam takes the direct read over a canonical value  | a canonical reading WINS          |
 * | the seam is dropped from `collectFullMetrics`          | the 86% alert; the standalone gap |
 *
 * Six mutations, eight arms. Fabricating in the `catch` is the one mutation
 * that trips two arms, and the pair is the point: it is caught both as a wrong
 * VALUE and as a silenced blindness alert, which are the two ways this
 * fallback could make the monitor worse than having no fallback at all.
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
  readDiskCapacityDirect,
} from "./health-monitor-plugin.ts"

/** A statfs reading, in the units `statfsSync` actually reports: blocks, not bytes. */
function statfsReading(over: Partial<ReturnType<typeof baseStatfs>> = {}): ReturnType<typeof baseStatfs> {
  return { ...baseStatfs(), ...over }
}

function baseStatfs() {
  return {
    bavail: 1_000,
    bfree: 1_200,
    blocks: 10_000,
    bsize: 4_096,
    ffree: 700,
    files: 1_000,
    type: 0x01021994,
  }
}

/** The process lane is inert here; every assertion below is about scalars. */
function noProcesses(): CanonicalProcessObservation {
  return {
    diagnostic: { excluded: [], location: "/hab/session", query: "latest exact process census" },
    kind: "unavailable",
    reason: "process-fact-unavailable",
    schema: "process-observation/1",
  }
}

/** A source whose canonical scalar lane carries nothing — this host, today. */
function blindSource(): HealthProcessSource {
  const scalars: CanonicalHostScalarObservation = {
    kind: "unavailable",
    reason: "scalar-fact-unavailable",
    schema: "host-scalar-observation/1",
  }
  return {
    kind: "managed",
    read: async () => noProcesses(),
    readScalars: async () => scalars,
  }
}

function stubPeripheralCommands() {
  return vi.spyOn(Bun, "spawn").mockImplementation((argv) => {
    const command = Array.isArray(argv) ? argv[0] : ""
    const stdout = command === "git" ? "/repo branch\n" : "0\n"
    return {
      exited: Promise.resolve(0),
      stderr: new Response("").body,
      stdout: new Response(stdout).body,
    } as unknown as ReturnType<typeof Bun.spawn>
  })
}

describe("direct disk capacity read", () => {
  it("maps a statfs reading to the canonical capacity, available blocks and not free ones", () => {
    const capacity = readDiskCapacityDirect("/tmp", (() => statfsReading()) as never)

    // bavail (1000) is what an unprivileged process may use; bfree (1200)
    // includes the reserve. Reporting the reserve as available is how a full
    // disk reads as having room.
    expect(capacity).toEqual({
      availableBytes: 1_000 * 4_096,
      freeBytes: 1_200 * 4_096,
      inodes: { kind: "supported", value: { free: 700, total: 1_000, used: 300 } },
      path: "/tmp",
      totalBytes: 10_000 * 4_096,
      usedBytes: 8_800 * 4_096,
    })
  })

  it("NEGATIVE CONTROL: an unreadable mount yields nothing and is never a zero-usage reading", () => {
    const capacity = readDiskCapacityDirect("/no/such/mount", (() => {
      throw new Error("ENOENT: no such file or directory, statfs '/no/such/mount'")
    }) as never)

    // The dangerous failure is not the throw — it is a capacity object built
    // from zeros, which renders as a disk at 0% and clears a live alert.
    expect(capacity).toBeUndefined()
  })

  it("reports nothing for a filesystem claiming no size, rather than a NaN percentage", () => {
    expect(readDiskCapacityDirect("/proc", (() => statfsReading({ blocks: 0 })) as never)).toBeUndefined()
  })

  it("NAMES a missing inode table instead of silently omitting it", () => {
    const capacity = readDiskCapacityDirect("/tmp", (() => statfsReading({ ffree: 0, files: 0 })) as never)

    expect(capacity?.inodes).toMatchObject({
      kind: "unavailable",
      metric: "disk.inodes",
      reason: "statfs-reported-no-inode-table",
    })
    // Bytes are still a real reading; a missing inode table must not cost them.
    expect(capacity?.totalBytes).toBe(10_000 * 4_096)
  })
})

describe("the direct read wired into collection", () => {
  it("fires the 85% warning on a host whose canonical lane produces nothing — the 2026-09-07 failure", async () => {
    const spawn = stubPeripheralCommands()
    // 86% of a 61G tmpfs, the reading that took four seats' shells.
    const reader = () => readDiskCapacityDirect("/tmp", (() => statfsReading({ bavail: 1_400, bfree: 1_400 })) as never)

    const { metrics } = await collectFullMetrics(blindSource(), { readDiskCapacity: reader })
    const alerts = evaluateAlerts(metrics, defaultThresholds(), createAlertState())

    expect(metrics.disk).toMatchObject({ path: "/tmp", totalBytes: 10_000 * 4_096 })
    expect(alerts.map((alert) => `${alert.type}:${alert.severity}`)).toContain("disk:warning")
    spawn.mockRestore()
  })

  it("fills the gap standalone mode leaves, where the sampler reports no disk at all", async () => {
    const spawn = stubPeripheralCommands()
    const osSampler = vi.fn(() => ({
      cpu: { coreCount: 4, loadAvg1m: 0.1, loadAvg5m: 0.1 },
      memory: { availableMB: 750, pressurePercent: 25, swapUsedMB: 0, totalMB: 1_000, usedMB: 250 },
      timestamp: 9_000,
    }))

    const { metrics } = await collectFullMetrics(
      { kind: "standalone-os" },
      {
        collectOsMetrics: osSampler,
        readDiskCapacity: () => readDiskCapacityDirect("/tmp", (() => statfsReading()) as never),
      },
    )

    expect(metrics.disk).toMatchObject({ path: "/tmp" })
    spawn.mockRestore()
  })

  it("a canonical reading WINS and the direct read is never consulted", async () => {
    const spawn = stubPeripheralCommands()
    const reader = vi.fn(() => {
      throw new Error("the direct read must not run while a canonical producer exists")
    })
    const scalars: CanonicalHostScalarObservation = {
      kind: "available",
      observedAt: 1_500,
      schema: "host-scalar-observation/1",
      source: { epoch: "host-a", sequence: 8 },
      values: {
        cpu: { kind: "unavailable", metric: "cpu", platform: "linux", reason: "not-collected" },
        disk: {
          kind: "supported",
          value: {
            availableBytes: 6 * 1024 ** 3,
            freeBytes: 6 * 1024 ** 3,
            inodes: { kind: "supported", value: { free: 600, total: 1_000, used: 400 } },
            path: "/canonical",
            totalBytes: 10 * 1024 ** 3,
            usedBytes: 4 * 1024 ** 3,
          },
        },
        diskIo: { kind: "unavailable", metric: "diskIo", platform: "linux", reason: "not-collected" },
        kind: "host:scalars",
        memory: { kind: "unavailable", metric: "memory", platform: "linux", reason: "not-collected" },
        sampleBudgetMs: 250,
        sampleDurationMs: 4,
        sampleOverBudget: false,
        swap: { kind: "unavailable", metric: "swap", platform: "linux", reason: "not-collected" },
      },
    }
    const source: HealthProcessSource = {
      kind: "managed",
      read: async () => noProcesses(),
      readScalars: async () => scalars,
    }

    const { metrics } = await collectFullMetrics(source, { readDiskCapacity: reader })

    // This is the death condition made mechanical: the moment the journal
    // carries a value, that value is the one reported, and the direct read is
    // dead code to be deleted rather than a second source of truth.
    expect(reader).not.toHaveBeenCalled()
    expect(metrics.disk).toMatchObject({ path: "/canonical" })
    spawn.mockRestore()
  })

  it("still announces blindness when the direct read cannot see either", async () => {
    const spawn = stubPeripheralCommands()
    const reader = () =>
      readDiskCapacityDirect("/gone", (() => {
        throw new Error("ENOENT")
      }) as never)
    const thresholds = defaultThresholds()
    const state = createAlertState()

    // Two consecutive samples: sustained blindness holds one open condition,
    // a single failed read does not page.
    const first = await collectFullMetrics(blindSource(), { readDiskCapacity: reader })
    evaluateAlerts(first.metrics, thresholds, state)
    const second = await collectFullMetrics(blindSource(), { readDiskCapacity: reader })
    const alerts = evaluateAlerts(second.metrics, thresholds, state)

    expect(second.metrics.disk).toBeUndefined()
    expect(alerts.map((alert) => alert.type)).toContain("disk")
    expect(alerts.find((alert) => alert.type === "disk")?.message).toMatch(/scalar-fact-unavailable/)
    spawn.mockRestore()
  })
})
