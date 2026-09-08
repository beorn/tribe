/**
 * @failure Managed Tribe monitoring silently falls back to ps, imports a Hab
 *          codec, or accepts a malformed neutral process-observation payload.
 * @level   l2
 * @consumer @hab/21960-hab-sysmon S2 routing and reaper cutover
 */

import { describe, expect, it, vi } from "vitest"
import { BoundedProcessCommandError } from "../../../recall/src/lib/bounded-process.ts"
import {
  createHealthProcessSource,
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
  it("ASKS, rather than explaining why it cannot, in the exact shape the incident measured", async () => {
    const runCommand = vi.fn(async (argv: readonly string[]) => ({
      exitCode: 0,
      stderr: "",
      stdout: `${JSON.stringify(argv.includes("scalars") ? scalarPayload : availablePayload)}\n`,
    }))
    // The live daemon's shape, measured from /proc/1240979/environ on
    // 2026-09-07: hab session markers present, both journal variables absent.
    const source = createHealthProcessSource({
      env: {
        HAB_SESSION_HABITAT_ROOT: "/hh/main.hab",
        HAB_SESSION_LAUNCH_ID: "70296c6b-21dd-41a9-8614-b6b6bff113e0",
      },
      runCommand,
    })

    // WHAT THIS ARM ASSERTS CHANGED, and the change IS the incident's cure, so
    // it is recorded rather than quietly swapped. It used to require
    // `misconfigured` — "under hab, cannot locate the journal" — which was the
    // honest answer while the habitat root located nothing. The root now
    // derives the journal, so requiring `misconfigured` here would pin the
    // blindness this bead exists to remove.
    //
    // The contract the incident actually bought is INTACT and asserted below: a
    // partially-hab environment is never reported as a healthy standalone. That
    // was the defect — `standalone-os` means "no journal EXISTS", and the
    // monitor said it while 22 live records sat in the journal. It is still
    // impossible. The loud branch keeps its own arm further down, in an
    // environment that genuinely offers nothing to go on.
    expect(source.kind, "a partially-hab environment is never a healthy standalone").not.toBe("standalone-os")
    expect(source.kind, "the habitat root the daemon already carries locates the journal").toBe("managed")
    if (source.kind !== "managed") throw new Error("unreachable")
    await expect(source.readScalars()).resolves.toEqual(scalarPayload)
    expect(runCommand, "and it must actually ask, which is the whole incident").toHaveBeenCalled()
    expect(runCommand).toHaveBeenCalledWith(expect.arrayContaining(["--state-root", "/hh/main.hab/run/sessions"]))
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
    expect(runCommand).toHaveBeenCalledWith(expect.arrayContaining(["--state-root", "/hh/main.hab/run/sessions"]))
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
  it("with NO way to locate the journal at all, the loud branch is unchanged", () => {
    // Gate 1's third arm. Narrowed, never deleted: an environment that offers
    // no way to find the journal is genuinely misconfigured and must say so.
    //
    // THE ENVIRONMENT IN THIS ARM CHANGED, and saying why is the honest part.
    // It used to carry `HAB_SESSION_HABITAT_ROOT` as well, because when it was
    // written that variable located nothing. It now locates the journal by
    // derivation, so leaving it here would assert that a locatable environment
    // is unlocatable — the test would be pinning the bug. What this arm has
    // always MEANT, nothing to go on so be loud, is preserved exactly by
    // dropping the one marker that is now something to go on.
    const runCommand = vi.fn()
    const source = createHealthProcessSource({
      env: { HAB_SESSION_LAUNCH_ID: "70296c6b-21dd-41a9-8614-b6b6bff113e0" },
      runCommand,
    })

    expect(source.kind).toBe("misconfigured")
    if (source.kind !== "misconfigured") throw new Error("unreachable")
    // NO SILENT ERRORS: a negative result names what it looked for. All three
    // keys, so the reader never has to guess which one would have helped.
    expect(source.reason).toContain("HAB_SESSION_DIR")
    expect(source.reason, "the loud branch names every key it looked for").toContain("HAB_SCALAR_JOURNAL_DIR")
    expect(source.reason).toContain("HAB_SESSION_HABITAT_ROOT")
    expect(runCommand, "a source with nowhere to look must not spawn a doomed read").not.toHaveBeenCalled()
  })

  /**
   * @failure A launcher-side injection cannot reach a process whose supervisor
   *          started before the injection existed: a long-running supervisor
   *          launches every child from the code it loaded at ITS start, and
   *          nothing in hab says so. Measured 2026-09-08 by a /proc environ
   *          walk over the live habitat: of ~194 hab-launched processes ZERO
   *          carried `HAB_SCALAR_JOURNAL_DIR`, including all 42 that launched
   *          AFTER the injection landed. So the daemon stays blind until its
   *          supervisor restarts — a fleet-wide event with ~194 descendants,
   *          which nobody may take for a monitoring fix
   *          (@i/4-supervision/24248, @chief ruling 328dd3b0).
   * @level   l2 — the source's own decision against a supplied environment,
   *          journal reader faked. The defect is in how the environment is
   *          READ, so a real journal would add cost and prove nothing more.
   * @consumer every scalar-backed alert in the Tribe daemon's health monitor —
   *           disk, memory, cpu, fd-count — the same set that went blind
   *           together and stayed blind through the launcher-side cure.
   *
   * Four arms, one contract: the derivation FIRES, it AGREES with the legacy
   * formula, it never OUTRANKS a value it was handed, and it stays LOUD when
   * it points somewhere empty.
   */
  describe("deriving the journal from the habitat root the daemon already carries", () => {
    const derivedStateRoot = "/hh/main.hab/run/sessions"

    function readerFake() {
      return vi.fn(async (argv: readonly string[]) => ({
        exitCode: 0,
        stderr: "",
        stdout: `${JSON.stringify(argv.includes("scalars") ? scalarPayload : availablePayload)}\n`,
      }))
    }

    it("reads the journal from the habitat root when NOTHING was injected", async () => {
      // The live daemon's measured environment, verbatim: the three markers the
      // standalone sanitizer leaves behind, and neither journal variable. This
      // is the case the launcher-side cure cannot reach.
      const runCommand = readerFake()
      const source = createHealthProcessSource({
        env: {
          HAB_SESSION_HABITAT_ROOT: "/hh/main.hab",
          HAB_SESSION_INSTRUCTION_ANCHOR: "/hh/main.hab/run/anchor",
          HAB_SESSION_LAUNCH_ID: "70296c6b-21dd-41a9-8614-b6b6bff113e0",
        },
        runCommand,
      })

      expect(source.kind, "a habitat root IS a way to find the journal").toBe("managed")
      if (source.kind !== "managed") throw new Error("expected managed source")
      await expect(source.readScalars()).resolves.toEqual(scalarPayload)
      expect(runCommand).toHaveBeenCalledWith(expect.arrayContaining(["--state-root", derivedStateRoot]))
    })

    it("AGREES with the legacy formula — the two derivations may never drift apart", async () => {
      // THE TRIPWIRE, and the reason this change is affordable. The legacy
      // branch already derives the controller journal by spelling `habmod`
      // beside the session dir it was given; this arm derives the same place
      // from the habitat root instead. They are two expressions of ONE layout,
      // so the risk is not that either is wrong today but that one is edited
      // later and the other is not. This test fails the moment they disagree.
      const readThrough = async (env: NodeJS.ProcessEnv, runCommand: ReturnType<typeof readerFake>) => {
        const source = createHealthProcessSource({ env, runCommand })
        if (source.kind !== "managed") throw new Error(`expected managed, got ${source.kind}`)
        await source.readScalars()
      }

      const legacyRun = readerFake()
      await readThrough(
        {
          HAB_SERVICE_KIND: "service",
          // any sibling session under the same habitat — the legacy branch
          // walks up one level and spells the controller name itself.
          HAB_SESSION_DIR: "/hh/main.hab/run/sessions/yrd-service",
        },
        legacyRun,
      )

      const derivedRun = readerFake()
      await readThrough(
        {
          HAB_SESSION_HABITAT_ROOT: "/hh/main.hab",
          HAB_SESSION_LAUNCH_ID: "70296c6b-21dd-41a9-8614-b6b6bff113e0",
        },
        derivedRun,
      )

      const stateRootOf = (fake: ReturnType<typeof readerFake>): string => {
        const argv = fake.mock.calls[0]?.[0]
        if (argv === undefined) throw new Error("the source never read — nothing to compare")
        const at = argv.indexOf("--state-root")
        if (at < 0) throw new Error(`no --state-root in ${argv.join(" ")}`)
        return argv[at + 1] ?? ""
      }

      expect(stateRootOf(derivedRun), "habitat-root derivation must equal the legacy derivation").toBe(
        stateRootOf(legacyRun),
      )
      expect(stateRootOf(derivedRun)).toBe(derivedStateRoot)
    })

    it("never OUTRANKS an injected root — a value handed over always wins over one derived", async () => {
      // Precedence, and it points the safe way: the launcher knows the layout's
      // owner and can name a non-default controller session; the consumer can
      // only assume the default. So when the launcher-side injection finally
      // does reach a process, it must win. The derivation is a floor, never a
      // ceiling, and this arm is what stops it quietly overriding the real fix.
      const runCommand = readerFake()
      const source = createHealthProcessSource({
        env: {
          HAB_SCALAR_JOURNAL_DIR: "/hh/other.hab/run/sessions/habmod",
          HAB_SESSION_HABITAT_ROOT: "/hh/main.hab",
          HAB_SESSION_LAUNCH_ID: "70296c6b-21dd-41a9-8614-b6b6bff113e0",
        },
        runCommand,
      })

      expect(source.kind).toBe("managed")
      if (source.kind !== "managed") throw new Error("expected managed source")
      await source.readScalars()
      // The INJECTED value's parent, never the derived one. It has to live under
      // a different habitat root to discriminate at all: a sibling of the
      // derived directory shares its parent, so the state-root would be
      // identical on both branches and the assertion would prove nothing.
      expect(runCommand).toHaveBeenCalledWith(expect.arrayContaining(["--state-root", "/hh/other.hab/run/sessions"]))
      const argv = runCommand.mock.calls[0]?.[0] ?? []
      expect(argv.join(" "), "the derived root must not appear at all").not.toContain(derivedStateRoot)
    })

    it("STAYS LOUD when the derived directory holds no journal, and NAMES the path it derived", async () => {
      // The anti-over-correction arm, and the property that makes deriving safe
      // at all: a derivation that guesses WRONG degrades to a loud `unavailable`
      // carrying the exact directory it checked. It can never degrade to
      // silence, so the worst case of this change is a reader who is told
      // precisely where we looked and found nothing.
      const runCommand = vi.fn(async () => ({ exitCode: 1, stderr: "no such directory", stdout: "" }))
      const source = createHealthProcessSource({
        env: {
          HAB_SESSION_HABITAT_ROOT: "/hh/main.hab",
          HAB_SESSION_LAUNCH_ID: "70296c6b-21dd-41a9-8614-b6b6bff113e0",
        },
        runCommand,
      })
      expect(source.kind).toBe("managed")
      if (source.kind !== "managed") throw new Error("expected managed source")

      const observation = await source.readScalars()
      expect(observation.kind, "a derivation that finds nothing is still blindness").toBe("unavailable")
      if (observation.kind !== "unavailable") throw new Error("unreachable")
      expect(observation.detail, "loudness must name the path it derived").toContain("/hh/main.hab/run/sessions/habmod")
      expect(runCommand, "and it must actually have looked").toHaveBeenCalled()
    })
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
