/**
 * @failure Managed Tribe monitoring silently falls back to ps, imports a Hab
 *          codec, or accepts a malformed neutral process-observation payload.
 * @level   l2
 * @consumer @hab/21960-hab-sysmon S2 routing and reaper cutover
 */

import { describe, expect, it, vi } from "vitest"
import {
  createHealthProcessSource,
  ManagedSysmonCommandError,
  runBoundedProcessCommand,
  SYSMON_CIRCUIT_FAILURES,
  SYSMON_CIRCUIT_OPEN_MS,
  SYSMON_COMMAND_TIMEOUT_MS,
  SYSMON_MAX_OUTPUT_BYTES,
} from "./health-process-source.ts"

const availablePayload = {
  diagnostic: {
    excluded: ["standalone-os-resample", "cross-batch-attribution", "implicit-unowned"],
    location: "/hab/habmod",
    query: "latest exact process census with owner attribution",
  },
  kind: "available",
  observedAt: 1_000,
  processes: [
    {
      attribution: { kind: "owned", ownerId: "@dev/3", via: "root" },
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
} as const

const scalarPayload = {
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
        availableBytes: 6_000_000_000,
        freeBytes: 6_000_000_000,
        inodes: { kind: "supported", value: { free: 600, total: 1_000, used: 400 } },
        path: "/",
        totalBytes: 10_000_000_000,
        usedBytes: 4_000_000_000,
      },
    },
    diskIo: { kind: "supported", value: { readWriteBytesPerSecond: 2_000_000 } },
    kind: "host:scalars",
    memory: {
      kind: "supported",
      value: { availableBytes: 6_000_000_000, totalBytes: 10_000_000_000, usedBytes: 4_000_000_000 },
    },
    sampleBudgetMs: 250,
    sampleDurationMs: 4,
    sampleOverBudget: false,
    swap: { kind: "supported", value: { freeBytes: 900_000_000, totalBytes: 1_000_000_000, usedBytes: 100_000_000 } },
  },
} as const

describe("neutral health process source", () => {
  it("uses the standalone OS source only when no managed session is declared", () => {
    const runCommand = vi.fn()
    const source = createHealthProcessSource({ env: {}, runCommand })

    expect(source).toEqual({ kind: "standalone-os" })
    expect(runCommand).not.toHaveBeenCalled()
  })

  it("does not treat an ambient seat session as the host source outside a Hab service", () => {
    const runCommand = vi.fn()
    const source = createHealthProcessSource({ env: { HAB_SESSION_DIR: "/hab/@dev-3" }, runCommand })

    expect(source).toEqual({ kind: "standalone-os" })
    expect(runCommand).not.toHaveBeenCalled()
  })

  it("pulls one explicit managed snapshot command without a shell or codec import", async () => {
    const runCommand = vi.fn(async (argv: readonly string[]) => ({
      exitCode: 0,
      stderr: "",
      stdout: `${JSON.stringify(argv.includes("scalars") ? scalarPayload : availablePayload)}\n`,
    }))
    const source = createHealthProcessSource({
      env: { HAB_SERVICE_KIND: "service", HAB_SESSION_DIR: "/hab/tribe" },
      runCommand,
    })
    expect(source.kind).toBe("managed")
    if (source.kind !== "managed") throw new Error("expected managed source")

    await expect(source.read()).resolves.toEqual(availablePayload)
    await expect(source.readScalars()).resolves.toEqual(scalarPayload)
    expect(runCommand).toHaveBeenCalledWith([
      "hab",
      "sysmon",
      "snapshot",
      "--state-root",
      "/hab",
      "--max-age-ms",
      "90000",
      "--json",
    ])
    expect(runCommand).toHaveBeenCalledWith([
      "hab",
      "sysmon",
      "snapshot",
      "--state-root",
      "/hab",
      "--kind",
      "scalars",
      "--max-age-ms",
      "90000",
      "--json",
    ])
  })

  it("fails closed on command failure and names query, location, and excluded fallback", async () => {
    const source = createHealthProcessSource({
      env: { HAB_SERVICE_KIND: "service", HAB_SESSION_DIR: "/hab/tribe" },
      runCommand: async () => ({ exitCode: 1, stderr: "journal unreadable", stdout: "" }),
    })
    if (source.kind !== "managed") throw new Error("expected managed source")

    await expect(source.read()).resolves.toMatchObject({
      diagnostic: {
        excluded: ["standalone-os-resample", "cross-batch-attribution", "implicit-unowned"],
        location: "/hab/habmod",
        query: "latest exact process census with owner attribution",
      },
      kind: "unavailable",
      reason: "source-command-failed",
      schema: "process-observation/1",
    })
  })

  it("keeps historical byte-only scalar records readable for consumer-side derivation", async () => {
    const { inodes: _inodes, ...historicalDisk } = scalarPayload.values.disk.value
    const payload = {
      ...scalarPayload,
      values: {
        ...scalarPayload.values,
        disk: { ...scalarPayload.values.disk, value: historicalDisk },
      },
    }
    const source = createHealthProcessSource({
      env: { HAB_SERVICE_KIND: "service", HAB_SESSION_DIR: "/hab/tribe" },
      runCommand: async () => ({ exitCode: 0, stderr: "", stdout: `${JSON.stringify(payload)}\n` }),
    })
    if (source.kind !== "managed") throw new Error("expected managed source")

    const observation = await source.readScalars()
    expect(observation.kind).toBe("available")
    if (observation.kind !== "available" || observation.values.disk.kind !== "supported") {
      throw new Error("expected supported historical byte capacity")
    }
    expect(observation.values.disk.value.inodes).toBeUndefined()
  })

  it("fails closed on malformed command output instead of returning an empty process list", async () => {
    const source = createHealthProcessSource({
      env: { HAB_SERVICE_KIND: "service", HAB_SESSION_DIR: "/hab/tribe" },
      runCommand: async () => ({ exitCode: 0, stderr: "", stdout: '{"kind":"available","processes":[]}\n' }),
    })
    if (source.kind !== "managed") throw new Error("expected managed source")

    await expect(source.read()).resolves.toMatchObject({
      kind: "unavailable",
      reason: "source-protocol-invalid",
    })
  })

  it("rejects a supposedly available row without executable identity", async () => {
    const payload = structuredClone(availablePayload) as any
    delete payload.processes[0].process.command
    const source = createHealthProcessSource({
      env: { HAB_SERVICE_KIND: "service", HAB_SESSION_DIR: "/hab/tribe" },
      runCommand: async () => ({ exitCode: 0, stderr: "", stdout: `${JSON.stringify(payload)}\n` }),
    })
    if (source.kind !== "managed") throw new Error("expected managed source")

    await expect(source.read()).resolves.toMatchObject({
      kind: "unavailable",
      reason: "source-protocol-invalid",
    })
  })

  it("rejects duplicate PIDs even when their start times differ", async () => {
    const payload = structuredClone(availablePayload) as any
    payload.processes.push({
      ...payload.processes[0],
      process: { ...payload.processes[0].process, startTime: "linux:boot:reused" },
    })
    const source = createHealthProcessSource({
      env: { HAB_SERVICE_KIND: "service", HAB_SESSION_DIR: "/hab/tribe" },
      runCommand: async () => ({ exitCode: 0, stderr: "", stdout: `${JSON.stringify(payload)}\n` }),
    })
    if (source.kind !== "managed") throw new Error("expected managed source")

    await expect(source.read()).resolves.toMatchObject({
      kind: "unavailable",
      reason: "source-protocol-invalid",
    })
  })

  it.each([
    ["empty query", (payload: any) => (payload.diagnostic.query = "")],
    ["empty location", (payload: any) => (payload.diagnostic.location = "")],
    ["wrong excluded fallbacks", (payload: any) => (payload.diagnostic.excluded = [])],
    [
      "empty unknown reason",
      (payload: any) => {
        payload.processes[0].attribution = {
          evidence: { ownerCount: 0, ownerIds: [], vias: [] },
          kind: "unknown",
          reason: "",
        }
      },
    ],
    [
      "empty unknown owner id",
      (payload: any) => {
        payload.processes[0].attribution = {
          evidence: { ownerCount: 1, ownerIds: [""], vias: ["root"] },
          kind: "unknown",
          reason: "owner-evidence-conflict",
        }
      },
    ],
    [
      "invented unknown via",
      (payload: any) => {
        payload.processes[0].attribution = {
          evidence: { ownerCount: 1, ownerIds: ["@dev/3"], vias: ["guess"] },
          kind: "unknown",
          reason: "owner-evidence-conflict",
        }
      },
    ],
  ])("rejects %s in process-observation/1", async (_name, mutate) => {
    const payload = structuredClone(availablePayload) as any
    mutate(payload)
    const source = createHealthProcessSource({
      env: { HAB_SERVICE_KIND: "service", HAB_SESSION_DIR: "/hab/tribe" },
      runCommand: async () => ({ exitCode: 0, stderr: "", stdout: `${JSON.stringify(payload)}\n` }),
    })
    if (source.kind !== "managed") throw new Error("expected managed source")

    await expect(source.read()).resolves.toMatchObject({
      kind: "unavailable",
      reason: "source-protocol-invalid",
    })
  })

  it.each([
    ["CPU utilization above 100 percent", (payload: any) => (payload.values.cpu.value.busyPercent = 500)],
    ["zero memory total", (payload: any) => (payload.values.memory.value.totalBytes = 0)],
    ["disk used beyond total", (payload: any) => (payload.values.disk.value.usedBytes = 20_000_000_000)],
    [
      "invented unavailable reason",
      (payload: any) =>
        (payload.values.diskIo = {
          kind: "unavailable",
          metric: "diskIo",
          platform: "linux",
          reason: "probably-fine",
        }),
    ],
  ])("rejects %s in host-scalar-observation/1", async (_name, mutate) => {
    const payload = structuredClone(scalarPayload) as any
    mutate(payload)
    const source = createHealthProcessSource({
      env: { HAB_SERVICE_KIND: "service", HAB_SESSION_DIR: "/hab/tribe" },
      runCommand: async () => ({ exitCode: 0, stderr: "", stdout: `${JSON.stringify(payload)}\n` }),
    })
    if (source.kind !== "managed") throw new Error("expected managed source")

    await expect(source.readScalars()).resolves.toMatchObject({
      kind: "unavailable",
      reason: "source-protocol-invalid",
    })
  })

  it("preserves valid fractional Darwin swap bytes", async () => {
    const payload = structuredClone(scalarPayload) as any
    payload.values.swap.value = { freeBytes: 900.5, totalBytes: 1_000, usedBytes: 99.5 }
    const source = createHealthProcessSource({
      env: { HAB_SERVICE_KIND: "service", HAB_SESSION_DIR: "/hab/tribe" },
      runCommand: async () => ({ exitCode: 0, stderr: "", stdout: `${JSON.stringify(payload)}\n` }),
    })
    if (source.kind !== "managed") throw new Error("expected managed source")

    await expect(source.readScalars()).resolves.toMatchObject({
      kind: "available",
      values: { swap: { kind: "supported", value: payload.values.swap.value } },
    })
  })

  /**
   * @failure health-monitor sample() re-spawns dual hab sysmon every poll and
   *          the unbounded stdout slurp + multi-GB habcp journal walk pegs the
   *          daemon core and times out every RPC (2026-08-13 live PID 2351697).
   */
  /**
   * Every test above injects a fake `runCommand`, so `runBoundedProcessCommand`
   * — the function that actually spawns, reads the pipes and enforces the
   * bounds — was never executed by the suite. These run it for real. They also
   * pin the typing the bounds depend on: `readStreamBounded` takes
   * `ReadableStream | null`, and it only ever receives a stream because the
   * subprocess type is inferred from `{ stdout: "pipe", stderr: "pipe" }`
   * rather than widened to every stdio mode at once.
   */
  describe("runBoundedProcessCommand (real spawn)", () => {
    it("returns the child's exit code and piped output", async () => {
      const result = await runBoundedProcessCommand(["echo", "sysmon-ok"], {
        timeoutMs: 5_000,
        maxOutputBytes: 64 * 1024,
      })
      expect(result.exitCode).toBe(0)
      expect(result.stdout.trim()).toBe("sysmon-ok")
      expect(result.stderr).toBe("")
    })

    it("reports a nonzero exit without treating it as a bound failure", async () => {
      // An ordinary failing command must NOT open the circuit breaker; only
      // timeout and oversize do. This is the path a missing --state-root takes.
      const result = await runBoundedProcessCommand(["sh", "-c", "echo boom >&2; exit 3"], {
        timeoutMs: 5_000,
        maxOutputBytes: 64 * 1024,
      })
      expect(result.exitCode).toBe(3)
      expect(result.stderr.trim()).toBe("boom")
    })

    it("raises spawn-failed when the binary does not exist", async () => {
      await expect(
        runBoundedProcessCommand(["tribe-sysmon-no-such-binary-cbb0f1"], {
          timeoutMs: 5_000,
          maxOutputBytes: 64 * 1024,
        }),
      ).rejects.toMatchObject({ failure: { kind: "spawn-failed" } })
    })

    it("kills and reports oversize rather than materialising the stream", async () => {
      // The live failure: a child that emits far more than the cap. The bound
      // must fire instead of building the whole string in the daemon's heap.
      await expect(
        runBoundedProcessCommand(["sh", "-c", "head -c 4000000 /dev/zero | tr '\\0' 'x'"], {
          timeoutMs: 10_000,
          maxOutputBytes: 64 * 1024,
        }),
      ).rejects.toMatchObject({ failure: { kind: "output-too-large" } })
    })

    it("kills and reports timeout when the child outlives its wall clock", async () => {
      await expect(
        runBoundedProcessCommand(["sleep", "5"], { timeoutMs: 250, maxOutputBytes: 64 * 1024 }),
      ).rejects.toMatchObject({ failure: { kind: "timeout" } })
    })
  })

  describe("sysmon sample hot-loop bounds", () => {
    it("exports the production bounds the live specimen violated", () => {
      // One JSON line is KB-scale; the live child burned ~1.5GB rchar per spawn.
      expect(SYSMON_MAX_OUTPUT_BYTES).toBeLessThan(1_000_000)
      // Multi-second journal walks must not outlive a poll window uncontested.
      expect(SYSMON_COMMAND_TIMEOUT_MS).toBeLessThanOrEqual(5_000)
      expect(SYSMON_CIRCUIT_FAILURES).toBeGreaterThanOrEqual(2)
      expect(SYSMON_CIRCUIT_OPEN_MS).toBeGreaterThanOrEqual(30_000)
    })

    it("maps a timeout throw to source-command-timeout without rethrowing", async () => {
      const runCommand = vi.fn(async () => {
        throw new ManagedSysmonCommandError({
          kind: "timeout",
          message: `sysmon snapshot exceeded ${SYSMON_COMMAND_TIMEOUT_MS}ms (killed)`,
        })
      })
      const source = createHealthProcessSource({
        env: { HAB_SERVICE_KIND: "service", HAB_SESSION_DIR: "/hab/tribe" },
        runCommand,
      })
      if (source.kind !== "managed") throw new Error("expected managed source")

      await expect(source.read()).resolves.toMatchObject({
        kind: "unavailable",
        reason: "source-command-timeout",
      })
      expect(runCommand).toHaveBeenCalledTimes(1)
    })

    it("maps oversized output to source-output-too-large", async () => {
      const runCommand = vi.fn(async () => {
        throw new ManagedSysmonCommandError({
          kind: "output-too-large",
          message: `sysmon snapshot exceeded ${SYSMON_MAX_OUTPUT_BYTES} byte stdout/stderr bound (killed)`,
        })
      })
      const source = createHealthProcessSource({
        env: { HAB_SERVICE_KIND: "service", HAB_SESSION_DIR: "/hab/tribe" },
        runCommand,
      })
      if (source.kind !== "managed") throw new Error("expected managed source")

      await expect(source.readScalars()).resolves.toMatchObject({
        kind: "unavailable",
        reason: "source-output-too-large",
      })
    })

    it("opens the circuit after consecutive hard failures and skips the next spawn", async () => {
      let nowMs = 1_000_000
      const runCommand = vi.fn(async () => {
        throw new ManagedSysmonCommandError({
          kind: "timeout",
          message: "sysmon snapshot exceeded 2500ms (killed)",
        })
      })
      const source = createHealthProcessSource({
        env: { HAB_SERVICE_KIND: "service", HAB_SESSION_DIR: "/hab/tribe" },
        runCommand,
        now: () => nowMs,
        circuitFailures: 2,
        circuitOpenMs: 60_000,
      })
      if (source.kind !== "managed") throw new Error("expected managed source")

      await expect(source.read()).resolves.toMatchObject({ reason: "source-command-timeout" })
      await expect(source.readScalars()).resolves.toMatchObject({ reason: "source-command-timeout" })
      expect(runCommand).toHaveBeenCalledTimes(2)

      // Circuit open: next attempt must not spawn.
      await expect(source.read()).resolves.toMatchObject({
        kind: "unavailable",
        reason: "source-circuit-open",
      })
      expect(runCommand).toHaveBeenCalledTimes(2)

      // After the open window, spawn is allowed again.
      nowMs += 60_001
      await expect(source.read()).resolves.toMatchObject({ reason: "source-command-timeout" })
      expect(runCommand).toHaveBeenCalledTimes(3)
    })

    it("does not open the circuit on ordinary exit-nonzero failures", async () => {
      const runCommand = vi.fn(async () => ({ exitCode: 1, stderr: "journal unreadable", stdout: "" }))
      const source = createHealthProcessSource({
        env: { HAB_SERVICE_KIND: "service", HAB_SESSION_DIR: "/hab/tribe" },
        runCommand,
        circuitFailures: 2,
      })
      if (source.kind !== "managed") throw new Error("expected managed source")

      await source.read()
      await source.read()
      await source.read()
      expect(runCommand).toHaveBeenCalledTimes(3)
      await expect(source.read()).resolves.toMatchObject({ reason: "source-command-failed" })
      expect(runCommand).toHaveBeenCalledTimes(4)
    })

    it("clears the circuit after a successful snapshot", async () => {
      let fail = true
      const runCommand = vi.fn(async (argv: readonly string[]) => {
        if (fail) {
          throw new ManagedSysmonCommandError({ kind: "timeout", message: "timeout" })
        }
        return {
          exitCode: 0,
          stderr: "",
          stdout: `${JSON.stringify(argv.includes("scalars") ? scalarPayload : availablePayload)}\n`,
        }
      })
      const source = createHealthProcessSource({
        env: { HAB_SERVICE_KIND: "service", HAB_SESSION_DIR: "/hab/tribe" },
        runCommand,
        circuitFailures: 2,
        circuitOpenMs: 60_000,
      })
      if (source.kind !== "managed") throw new Error("expected managed source")

      await source.read()
      fail = false
      await expect(source.read()).resolves.toMatchObject({ kind: "available" })
      // One more hard failure must not open the circuit alone (counter reset).
      fail = true
      await expect(source.read()).resolves.toMatchObject({ reason: "source-command-timeout" })
      await expect(source.readScalars()).resolves.toMatchObject({ reason: "source-command-timeout" })
      // That second consecutive failure opens it — third spawn skipped:
      await expect(source.read()).resolves.toMatchObject({ reason: "source-circuit-open" })
      expect(runCommand.mock.calls.length).toBe(4)
    })
  })
})
