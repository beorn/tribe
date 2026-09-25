/**
 * @failure Managed Tribe monitoring silently falls back to ps, imports a Hab
 *          codec, or accepts a malformed neutral process-observation payload.
 * @level   l2
 * @consumer @hab/21960-hab-sysmon S2 routing and reaper cutover
 */

import { describe, expect, it, vi } from "vitest"
import { BoundedProcessCommandError, runBoundedProcessCommand } from "../../../recall/src/lib/bounded-process.ts"
import {
  createHealthProcessSource,
  SYSMON_CIRCUIT_FAILURES,
  SYSMON_CIRCUIT_OPEN_MS,
  SYSMON_COMMAND_TIMEOUT_MAX_MS,
  SYSMON_COMMAND_TIMEOUT_MS,
  SYSMON_MAX_OUTPUT_BYTES,
  sysmonCommandTimeoutMs,
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

  /**
   * @failure The daemon reported `standalone-os` — "not under hab, no journal
   *          exists" — while running UNDER hab on a host whose journal held 22
   *          live `host:scalars` records. It never attempted a scalar read, so
   *          no disk threshold could ever fire; /tmp reached 86% and four seats
   *          lost their shells with the monitor reporting healthy.
   *
   *          Nothing in the chain was a mistake. `sanitizeStandaloneDaemonEnvironment`
   *          strips `HAB_SESSION_DIR`, `HAB_SERVICE_KIND` and `HAB_SERVICE_NAME`
   *          before minting a standalone supervisor, CORRECTLY, so the daemon
   *          cannot inherit hab's idle-quit marker and leak. The defect is the
   *          COMPOSITION: one set of variables answering both "am I hab-MANAGED"
   *          (a lifecycle question, correctly no) and "can I READ this host's
   *          journal" (correctly yes), whose right answers point opposite ways.
   * @level   l2 — the source's own decision against a supplied environment.
   * @consumer every scalar-backed alert — disk, memory, cpu, fd-count — all
   *           silent for this ONE reason (@i/4-supervision/24233).
   */
  it("says WHY it cannot ask when the environment is hab-shaped but unconfigured", () => {
    const runCommand = vi.fn()
    // The live daemon's shape, measured from /proc/1240979/environ on
    // 2026-09-07: hab session markers present, the gate variable absent.
    const source = createHealthProcessSource({
      env: {
        HAB_SESSION_HABITAT_ROOT: "/hh/main.hab",
        HAB_SESSION_LAUNCH_ID: "70296c6b-21dd-41a9-8614-b6b6bff113e0",
      },
      runCommand,
    })

    expect(source.kind, "a partially-hab environment is not a healthy standalone").toBe("misconfigured")
    if (source.kind !== "misconfigured") throw new Error("unreachable")
    // Actionable on its own: it names the variable that is missing and the ones
    // that prove hab is present, so the reader is not left to guess which half
    // of the contradiction to chase.
    expect(source.reason).toContain("HAB_SESSION_DIR")
    expect(source.reason).toContain("HAB_SESSION_HABITAT_ROOT")
    expect(runCommand, "a misconfigured source must not spawn a doomed read").not.toHaveBeenCalled()
  })

  /**
   * @failure ONE variable answered two unrelated questions. `HAB_SESSION_DIR`
   *          carried BOTH the hab lifecycle-quit marker and the journal's
   *          location, so stripping it to stop a standalone daemon inheriting
   *          hab's idle-quit — which is correct — also severed the daemon's
   *          ability to find the journal. Every scalar-backed alert went silent
   *          while reporting healthy; /tmp reached 86% and four seats lost
   *          their shells (@i/4-supervision/24233, @i/4-supervision/24248).
   * @level   l2 — the source's own decision, with the journal reader faked.
   *          The lowest level that can exercise it: the defect is in how the
   *          environment is READ, so a real journal would add cost and prove
   *          nothing this does not.
   * @consumer every scalar-backed alert in the Tribe daemon's health monitor —
   *           disk, memory, cpu, fd-count — all of which read through
   *           `createHealthProcessSource` and all of which went blind together.
   *
   * Three arms, one contract: this case proves the cure works, the next proves
   * it did not over-correct, and the third proves the loud branch is untouched.
   */
  it("reads the journal again when the root is injected, with the lifecycle marker still stripped", async () => {
    // THE CURE, and the shape of it matters: the daemon is NOT told it is
    // hab-managed — `HAB_SESSION_DIR` and `HAB_SERVICE_KIND` stay stripped, so
    // it still cannot inherit hab's idle-quit and still retires correctly. It
    // is told only WHERE THE JOURNAL IS. Lifecycle and journal access were one
    // variable; this is them apart.
    const runCommand = vi.fn(async (argv: readonly string[]) => ({
      exitCode: 0,
      stderr: "",
      stdout: `${JSON.stringify(argv.includes("scalars") ? scalarPayload : availablePayload)}\n`,
    }))
    const source = createHealthProcessSource({
      env: {
        HAB_SCALAR_JOURNAL_DIR: "/hh/main.hab/run/sessions/habmod",
        HAB_SESSION_HABITAT_ROOT: "/hh/main.hab",
        HAB_SESSION_LAUNCH_ID: "70296c6b-21dd-41a9-8614-b6b6bff113e0",
      },
      runCommand,
    })

    expect(source.kind, "an injected journal root is readable, not misconfigured").toBe("managed")
    if (source.kind !== "managed") throw new Error("expected managed source")
    await expect(source.readScalars()).resolves.toEqual(scalarPayload)
    // The state root is the PARENT of the injected controller dir, so the
    // consumer spells neither `run/sessions` nor `habmod` anywhere.
    expect(runCommand).toHaveBeenCalledWith(
      expect.arrayContaining(["--state-root", "/hh/main.hab/run/sessions"]),
      expect.any(Number),
    )
  })

  /**
   * @failure Over-correction: a change that restores journal access could just
   *          as easily have silenced the genuine blindness it was meant to
   *          narrow, leaving an empty or unreadable journal reporting healthy.
   * @level   l2 — same reader, faked to fail; see the contract three cases up.
   * @consumer the same scalar-backed alerts — this is the arm that keeps them
   *           loud when the journal really is missing.
   */
  it("STILL goes loud when the injected root holds no journal — blindness is only narrowed", async () => {
    // THE RED FIXTURE @cto REQUIRED, and the one that proves I did not
    // over-correct. The ONLY case this change removes is fresh-feed-wrong-place.
    // A genuinely empty or unreadable journal must remain as loud as it is
    // today, and must name the path it actually checked rather than saying a
    // generic nothing.
    const runCommand = vi.fn(async () => ({ exitCode: 1, stderr: "no such directory", stdout: "" }))
    const source = createHealthProcessSource({
      env: {
        HAB_SCALAR_JOURNAL_DIR: "/hh/main.hab/run/sessions/habmod",
        HAB_SESSION_HABITAT_ROOT: "/hh/main.hab",
        HAB_SESSION_LAUNCH_ID: "70296c6b-21dd-41a9-8614-b6b6bff113e0",
      },
      runCommand,
    })
    expect(source.kind).toBe("managed")
    if (source.kind !== "managed") throw new Error("expected managed source")

    const observation = await source.readScalars()
    // `unavailable` IS the blind signal at this layer; the plugin lifts it to
    // `canonical-unavailable` before the alert. Asserting the source-level kind
    // keeps this test about the source rather than about the plugin.
    expect(observation.kind, "an empty journal is still blindness").toBe("unavailable")
    // GATE 3's "names itself", and it is already honoured: the diagnostic
    // carries the exact directory that was checked, so the reader is never told
    // a generic nothing.
    if (observation.kind !== "unavailable") throw new Error("unreachable")
    expect(observation.detail, "loudness must name the path it looked in").toContain("/hh/main.hab/run/sessions/habmod")
    expect(runCommand, "and it must actually have looked").toHaveBeenCalled()
  })

  /**
   * @failure Regression in the untouched arm: an environment offering no way to
   *          find the journal at all must stay exactly as loud as it was, or
   *          the narrowing becomes a deletion.
   * @level   l2 — same reader; see the contract two cases up.
   * @consumer the same scalar-backed alerts, in the case where nothing can be
   *           read and saying so is the whole product.
   */
  it("with NEITHER the lifecycle marker nor an injected root, the loud branch is unchanged", () => {
    // Gate 1's third arm. Narrowed, never deleted: an environment that offers
    // no way to find the journal is genuinely misconfigured and must say so
    // exactly as it does today.
    const runCommand = vi.fn()
    const source = createHealthProcessSource({
      env: {
        HAB_SESSION_HABITAT_ROOT: "/hh/main.hab",
        HAB_SESSION_LAUNCH_ID: "70296c6b-21dd-41a9-8614-b6b6bff113e0",
      },
      runCommand,
    })

    expect(source.kind).toBe("misconfigured")
    if (source.kind !== "misconfigured") throw new Error("unreachable")
    expect(source.reason).toContain("HAB_SESSION_DIR")
    expect(runCommand, "a source with nowhere to look must not spawn a doomed read").not.toHaveBeenCalled()
  })

  it("a genuinely non-hab environment stays standalone-os and stays SILENT", () => {
    // The control, and the reason the check is narrow: on a host with no hab at
    // all there IS no journal, so silence is honest and must not become noise.
    // The three delivery tests that enforce this keep their exact meaning.
    const runCommand = vi.fn()
    const source = createHealthProcessSource({ env: { PATH: "/usr/bin" }, runCommand })

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
    expect(runCommand).toHaveBeenCalledWith(
      ["hab", "sysmon", "snapshot", "--state-root", "/hab", "--max-age-ms", "90000", "--json"],
      expect.any(Number),
    )
    expect(runCommand).toHaveBeenCalledWith(
      ["hab", "sysmon", "snapshot", "--state-root", "/hab", "--kind", "scalars", "--max-age-ms", "90000", "--json"],
      expect.any(Number),
    )
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
        location: "/hab",
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

  it("keeps hab sysmon's excludedRows, and refuses a malformed one as a protocol error (hh 25917)", async () => {
    const read = async (excludedRows: unknown) => {
      const source = createHealthProcessSource({
        env: { HAB_SERVICE_KIND: "service", HAB_SESSION_DIR: "/hab/tribe" },
        runCommand: async () => ({
          exitCode: 0,
          stderr: "",
          stdout: `${JSON.stringify({ ...structuredClone(availablePayload), excludedRows })}\n`,
        }),
      })
      if (source.kind !== "managed") throw new Error("expected managed source")
      return source.read()
    }
    const excludedRows = [{ command: "git super merge", detail: "invalid pgid", field: "pgid", pid: 20, value: -1 }]

    await expect(read(excludedRows)).resolves.toMatchObject({ kind: "available", excludedRows })
    await expect(read([{ command: "git super merge", pid: 20 }])).resolves.toMatchObject({
      kind: "unavailable",
      reason: "source-protocol-invalid",
    })
  })

  it("admits kernel threads and root processes with pgid 0", async () => {
    const payload = structuredClone(availablePayload) as any
    payload.processes.push({
      attribution: { kind: "unowned" },
      process: {
        command: "[kthreadd]",
        cpuPercent: 0,
        pgid: 0,
        pid: 2,
        ppid: 0,
        rssBytes: 0,
        startTime: "linux:boot:2",
      },
    })
    const source = createHealthProcessSource({
      env: { HAB_SERVICE_KIND: "service", HAB_SESSION_DIR: "/hab/tribe" },
      runCommand: async () => ({ exitCode: 0, stderr: "", stdout: `${JSON.stringify(payload)}\n` }),
    })
    if (source.kind !== "managed") throw new Error("expected managed source")

    const result = await source.read()
    expect(result.kind).toBe("available")
    if (result.kind !== "available") throw new Error("expected available result")
    expect(result.processes).toHaveLength(2)
    expect(result.processes[1]?.process.pgid).toBe(0)
    expect(result.processes[1]?.process.command).toBe("[kthreadd]")
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
  describe("sysmon sample hot-loop bounds", () => {
    it("exports the production bounds the live specimen violated", () => {
      // One JSON line is KB/MB-scale; the live child burned ~1.5GB rchar per spawn.
      expect(SYSMON_MAX_OUTPUT_BYTES).toBeLessThanOrEqual(2_000_000)
      // Multi-second journal walks must not outlive a poll window uncontested.
      expect(SYSMON_COMMAND_TIMEOUT_MS).toBeLessThanOrEqual(5_000)
      expect(SYSMON_CIRCUIT_FAILURES).toBeGreaterThanOrEqual(2)
      expect(SYSMON_CIRCUIT_OPEN_MS).toBeGreaterThanOrEqual(30_000)
    })

    it("sizes the output bound to host process counts with room to admit a census twice today's size", () => {
      // Measured 2026-09-23 live host census (live-verification-report.md): 886 processes produced 278,044 bytes.
      const liveSpecimenBytes = 278_044
      const twiceTodaySize = liveSpecimenBytes * 2 // 556,088 bytes (~1,772 processes)

      // The historical 256 KiB (262,144 bytes) cap refused the live 278 KB census.
      const previousCapBytes = 256 * 1024
      expect(liveSpecimenBytes).toBeGreaterThan(previousCapBytes)

      // Sized to host process counts with generous room (up to ~6,500 processes = 2,000,000 bytes, ~1.9 MiB),
      // admitting ~7x today's census and ~3.5x twice-today while keeping multi-GB journal walks bounded.
      expect(SYSMON_MAX_OUTPUT_BYTES).toBeGreaterThan(twiceTodaySize)
      expect(SYSMON_MAX_OUTPUT_BYTES).toBe(2_000_000)
    })

    it("refuses output above the byte bound as source-output-too-large and stays loud", async () => {
      // Red arm: under the old 256 KiB cap, today's 278,044-byte census exceeds the bound and is refused
      const oldCap = 256 * 1024
      const liveSpecimenBytes = 278_044
      expect(liveSpecimenBytes).toBeGreaterThan(oldCap)

      await expect(
        runBoundedProcessCommand([process.execPath, "-e", `process.stdout.write("x".repeat(${liveSpecimenBytes}))`], {
          timeoutMs: 2_500,
          killGraceMs: 500,
          reapGraceMs: 500,
          drainGraceMs: 500,
          maxOutputBytes: oldCap,
        }),
      ).rejects.toMatchObject({
        failure: {
          kind: "output-too-large",
          stream: "stdout",
        },
      })

      // Green arm: with the new production bound, twice today's census is admitted
      const twiceTodayBytes = liveSpecimenBytes * 2
      const admitted = await runBoundedProcessCommand(
        [process.execPath, "-e", `process.stdout.write("x".repeat(${twiceTodayBytes}))`],
        {
          timeoutMs: 2_500,
          killGraceMs: 500,
          reapGraceMs: 500,
          drainGraceMs: 500,
          maxOutputBytes: SYSMON_MAX_OUTPUT_BYTES,
        },
      )
      expect(admitted.stdout.length).toBe(twiceTodayBytes)

      // Refusal stays loud above the new bound
      const overBoundBytes = SYSMON_MAX_OUTPUT_BYTES + 1_024
      await expect(
        runBoundedProcessCommand([process.execPath, "-e", `process.stdout.write("x".repeat(${overBoundBytes}))`], {
          timeoutMs: 2_500,
          killGraceMs: 500,
          reapGraceMs: 500,
          drainGraceMs: 500,
          maxOutputBytes: SYSMON_MAX_OUTPUT_BYTES,
        }),
      ).rejects.toMatchObject({
        failure: {
          kind: "output-too-large",
          stream: "stdout",
        },
      })
    })

    it("maps a timeout throw to source-command-timeout without rethrowing", async () => {
      const runCommand = vi.fn(async () => {
        throw new BoundedProcessCommandError({
          kind: "timeout",
          message: `sysmon snapshot exceeded ${SYSMON_COMMAND_TIMEOUT_MS}ms (killed)`,
          settlementFailures: [],
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
        throw new BoundedProcessCommandError({
          kind: "output-too-large",
          message: `sysmon snapshot exceeded ${SYSMON_MAX_OUTPUT_BYTES} byte stdout/stderr bound (killed)`,
          settlementFailures: [],
          stream: "stdout",
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
        throw new BoundedProcessCommandError({
          kind: "timeout",
          message: "sysmon snapshot exceeded 2500ms (killed)",
          settlementFailures: [],
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

    /**
     * @failure At this host's normal evening load (30 to 60 on 32 cores) the snapshot outran its fixed 2.5 s
     *          ceiling five times in an hour, and two hard failures opened the circuit, so host scalar
     *          monitoring went BLIND at 21:46 PDT 2026-09-24 with the producer and reader both healthy (24248).
     */
    it("scales the snapshot ceiling with the load per core, from the base on an idle host to a fixed cap", () => {
      expect(sysmonCommandTimeoutMs(0, 32)).toBe(SYSMON_COMMAND_TIMEOUT_MS)
      expect(sysmonCommandTimeoutMs(32, 32)).toBe(2 * SYSMON_COMMAND_TIMEOUT_MS)
      expect(sysmonCommandTimeoutMs(48, 32)).toBe(6_250)
      expect(sysmonCommandTimeoutMs(500, 32)).toBe(SYSMON_COMMAND_TIMEOUT_MAX_MS)
      // An unreadable load (0 on a platform without one, or not a number) is the base, never a larger bound.
      expect(sysmonCommandTimeoutMs(Number.NaN, 32)).toBe(SYSMON_COMMAND_TIMEOUT_MS)
      expect(sysmonCommandTimeoutMs(-1, 32)).toBe(SYSMON_COMMAND_TIMEOUT_MS)
      expect(SYSMON_COMMAND_TIMEOUT_MAX_MS).toBeLessThanOrEqual(10_000)
    })

    it("takes each snapshot's ceiling from the load hab last reported, the base before any report", async () => {
      const withLoad = (load1: number) => ({
        ...scalarPayload,
        values: {
          ...scalarPayload.values,
          cpu: {
            ...scalarPayload.values.cpu,
            value: { ...scalarPayload.values.cpu.value, loadAverage1m: load1, logicalCores: 32 },
          },
        },
      })
      const loads = [48, 0]
      const ceilings: number[] = []
      const runCommand = vi.fn(async (argv: readonly string[], timeoutMs: number) => {
        ceilings.push(timeoutMs)
        return {
          exitCode: 0,
          stderr: "",
          stdout: `${JSON.stringify(argv.includes("scalars") ? withLoad(loads.shift() ?? 0) : availablePayload)}\n`,
        }
      })
      const source = createHealthProcessSource({
        env: { HAB_SERVICE_KIND: "service", HAB_SESSION_DIR: "/hab/tribe" },
        runCommand,
      })
      if (source.kind !== "managed") throw new Error("expected managed source")

      await source.readScalars() // no report yet: the base; hab reports load 48 on 32 cores
      await source.read() // 2.5 s × (1 + 48/32)
      await source.readScalars() // still 48; hab now reports an idle host
      await source.read()
      expect(ceilings).toEqual([SYSMON_COMMAND_TIMEOUT_MS, 6_250, 6_250, SYSMON_COMMAND_TIMEOUT_MS])
    })

    it("cold start under load: the base ceiling until the first scalar lands, then the scale from that report on", async () => {
      // @cto ef3f9fdb: a daemon that starts in a spike has no scalar yet, so it keeps the base ceiling exactly when
      // the snapshot is slow, and can open the circuit before its first report; the next success seeds the scale.
      let nowMs = 1_000_000
      let failing = true
      const ceilings: number[] = []
      const runCommand = vi.fn(async (argv: readonly string[], timeoutMs: number) => {
        ceilings.push(timeoutMs)
        if (failing) {
          throw new BoundedProcessCommandError({ kind: "timeout", message: "timeout", settlementFailures: [] })
        }
        const scalars = {
          ...scalarPayload,
          values: {
            ...scalarPayload.values,
            cpu: {
              ...scalarPayload.values.cpu,
              value: { ...scalarPayload.values.cpu.value, loadAverage1m: 60, logicalCores: 32 },
            },
          },
        }
        return {
          exitCode: 0,
          stderr: "",
          stdout: `${JSON.stringify(argv.includes("scalars") ? scalars : availablePayload)}\n`,
        }
      })
      const source = createHealthProcessSource({
        env: { HAB_SERVICE_KIND: "service", HAB_SESSION_DIR: "/hab/tribe" },
        runCommand,
        now: () => nowMs,
      })
      if (source.kind !== "managed") throw new Error("expected managed source")
      const poll = () => Promise.all([source.read(), source.readScalars()])

      for (let failed = 0; failed < 3; failed += 1) await poll()
      await expect(source.read()).resolves.toMatchObject({ reason: "source-circuit-open" })
      expect(ceilings).toEqual(Array(SYSMON_CIRCUIT_FAILURES).fill(SYSMON_COMMAND_TIMEOUT_MS))

      // The circuit heals after its window, and the first success is the first report: still the base.
      nowMs += SYSMON_CIRCUIT_OPEN_MS + 1
      failing = false
      await poll()
      // From that report on, every snapshot asks for 2.5 s × (1 + 60/32).
      await poll()
      expect(ceilings.slice(SYSMON_CIRCUIT_FAILURES)).toEqual([2_500, 2_500, 7_188, 7_188])
    })

    it("keeps spawning through two whole failed polls and opens the circuit only on the third", async () => {
      const runCommand = vi.fn(async () => {
        throw new BoundedProcessCommandError({ kind: "timeout", message: "timeout", settlementFailures: [] })
      })
      const source = createHealthProcessSource({
        env: { HAB_SERVICE_KIND: "service", HAB_SESSION_DIR: "/hab/tribe" },
        runCommand,
      })
      if (source.kind !== "managed") throw new Error("expected managed source")

      // A poll reads the census and the scalars together, so each failed poll is two hard failures.
      for (let poll = 0; poll < 3; poll += 1) {
        await expect(Promise.all([source.read(), source.readScalars()])).resolves.toMatchObject([
          { reason: "source-command-timeout" },
          { reason: "source-command-timeout" },
        ])
      }
      expect(runCommand).toHaveBeenCalledTimes(SYSMON_CIRCUIT_FAILURES)
      await expect(source.read()).resolves.toMatchObject({ reason: "source-circuit-open" })
      expect(runCommand).toHaveBeenCalledTimes(SYSMON_CIRCUIT_FAILURES)
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
          throw new BoundedProcessCommandError({ kind: "timeout", message: "timeout", settlementFailures: [] })
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
