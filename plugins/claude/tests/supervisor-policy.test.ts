import { describe, expect, it } from "vitest"
import {
  ADAPTER_STABLE_MS,
  evaluateAdapterRestart,
  REEXEC_BACKOFF_BASE_MS,
  REEXEC_BACKOFF_MAX_MS,
  judgeSeatAncestry,
  LEGACY_PARENT_WARNING,
  PROVIDER_PARENT_REMEDY,
  resolveProviderParentPid,
} from "../supervisor-policy.ts"
import {
  buildPluginAdapterEnvironment,
  PLUGIN_REEXEC_EXIT_CODE,
  PLUGIN_REEXEC_EXIT_CODE_ENV,
} from "../supervisor-environment.ts"
import type { ParentPidReading } from "tribe-wire/lib/process-parent"

describe("Claude plugin adapter restart budget", () => {
  it("puts the re-exec value in the actual supervised child environment", () => {
    const env = buildPluginAdapterEnvironment({ [PLUGIN_REEXEC_EXIT_CODE_ENV]: "" }, 4321)

    expect(env[PLUGIN_REEXEC_EXIT_CODE_ENV]).toBe(String(PLUGIN_REEXEC_EXIT_CODE))
    expect(env.TRIBE_PLUGIN_ADAPTER_CHILD).toBe("1")
    expect(env.TRIBE_PLUGIN_PROVIDER_PARENT_PID).toBe("4321")
  })

  // 28743 — the supervisor is the only process whose memory spans adapter
  // replacements, so only its own seed passes through to a child; an inherited
  // value is cleared rather than reused as an unearned suppress.
  it("hands a respawned adapter the announced delivery seed and clears an inherited one", () => {
    const respawned = buildPluginAdapterEnvironment({}, 4321, undefined, null, "push/push")
    expect(respawned.TRIBE_PLUGIN_ANNOUNCED_DELIVERY).toBe("push/push")

    const firstSpawn = buildPluginAdapterEnvironment({ TRIBE_PLUGIN_ANNOUNCED_DELIVERY: "push/push" }, 4321)
    expect(firstSpawn.TRIBE_PLUGIN_ANNOUNCED_DELIVERY).toBeUndefined()
  })

  it("allows a second quick re-exec when two legitimate daemon generations arrive in one restart burst", () => {
    expect(evaluateAdapterRestart(1, 250, 10_000, Number.POSITIVE_INFINITY, () => 0.5)).toEqual({
      consecutiveReexecs: 2,
      retry: true,
      retryDelayMs: 500,
    })
  })

  it("keeps non-generation re-exec failures on the one-retry fail-loud path", () => {
    expect(evaluateAdapterRestart(1, 250, 10_000, 1, () => 0.5)).toEqual({
      consecutiveReexecs: 2,
      retry: false,
      retryDelayMs: 0,
    })
  })

  // 25663: decorrelated jitter from the previous delay, never below the base and never above the cap.
  it("retries a persistently crashing adapter forever, each delay in [base, min(cap, previous × 3)]", () => {
    let consecutiveReexecs = 0
    let previous = 0
    let state = 7
    const random = () => ((state = (state * 48271) % 2147483647) - 1) / 2147483646
    for (let attempt = 1; attempt <= 200; attempt += 1) {
      const decision = evaluateAdapterRestart(consecutiveReexecs, previous, 10_000, Number.POSITIVE_INFINITY, random)
      expect(decision.consecutiveReexecs).toBe(attempt)
      expect(decision.retry).toBe(true)
      expect(decision.retryDelayMs).toBeGreaterThanOrEqual(REEXEC_BACKOFF_BASE_MS)
      expect(decision.retryDelayMs).toBeLessThanOrEqual(
        Math.min(REEXEC_BACKOFF_MAX_MS, Math.max(REEXEC_BACKOFF_BASE_MS, previous) * 3),
      )
      consecutiveReexecs = decision.consecutiveReexecs
      previous = decision.retryDelayMs
    }
  })

  it("never retries at zero delay, and reaches the cap from a long previous delay", () => {
    expect(evaluateAdapterRestart(7, 0, 10_000, Number.POSITIVE_INFINITY, () => 0).retryDelayMs).toBe(
      REEXEC_BACKOFF_BASE_MS,
    )
    expect(evaluateAdapterRestart(7, 20_000, 10_000, Number.POSITIVE_INFINITY, () => 1).retryDelayMs).toBe(
      REEXEC_BACKOFF_MAX_MS,
    )
  })

  it("re-arms one replacement after a genuinely stable adapter lifetime", () => {
    expect(ADAPTER_STABLE_MS).toBeGreaterThan(60_000)
    expect(evaluateAdapterRestart(1, 20_000, ADAPTER_STABLE_MS, Number.POSITIVE_INFINITY, () => 0.5)).toEqual({
      consecutiveReexecs: 1,
      retry: true,
      retryDelayMs: 500,
    })
  })
})

// 25074 3c-2b (@cto def441bf): a seat that registered by its token is launched with no TRIBE_LAUNCH_ID, so its wrapper
// must accept the token as the managed identity beside a supplied provider parent, never throw its remedy.
describe("provider-parent provenance", () => {
  const self = { pid: 100, ppid: 50 }
  const alive = () => true

  it("a token launch with a supplied provider parent resolves it, where TRIBE_LAUNCH_ID used to be required", () => {
    expect(
      resolveProviderParentPid(
        { HAB_ID_TOKEN: "seat-token", TRIBE_PLUGIN_PROVIDER_PARENT_PID: "4321" },
        self,
        alive,
        () => {},
      ),
    ).toEqual({ pid: 4321, declared: true })
  })

  it("a supplied provider parent with no managed identity at all is an incomplete tuple and throws the remedy", () => {
    expect(() => resolveProviderParentPid({ TRIBE_PLUGIN_PROVIDER_PARENT_PID: "4321" }, self, alive, () => {})).toThrow(
      PROVIDER_PARENT_REMEDY,
    )
  })

  it("a TRIBE_LAUNCH_ID without a token is no managed identity: a supplied parent beside it throws the remedy (3d-2)", () => {
    expect(() =>
      resolveProviderParentPid(
        { TRIBE_LAUNCH_ID: "launch-1", TRIBE_PLUGIN_PROVIDER_PARENT_PID: "4321" },
        self,
        alive,
        () => {},
      ),
    ).toThrow(PROVIDER_PARENT_REMEDY)
  })

  it("a managed launch with no provider parent falls back to the real parent, loudly", () => {
    const warnings: string[] = []
    expect(
      resolveProviderParentPid({ HAB_ID_TOKEN: "seat-token" }, self, alive, (line) => warnings.push(line)),
    ).toEqual({ pid: 50, declared: false })
    expect(warnings).toEqual([LEGACY_PARENT_WARNING])
  })
})

describe("seat ancestry (29567)", () => {
  // The provider is this supervisor's parent (50); the launch declares its harness (4321), which started the provider.
  const providerPid = 50
  const harness = 4321
  const parents =
    (table: Record<number, number>) =>
    (pid: number): ParentPidReading =>
      table[pid] === undefined
        ? { ppid: null, reason: `/proc/${pid}/stat is unreadable (ENOENT)` }
        : { ppid: table[pid] }

  it("a supervisor whose provider is a direct child of the declared harness is the seat's", () => {
    expect(judgeSeatAncestry(harness, providerPid, parents({ [providerPid]: harness }))).toEqual({ kind: "seat" })
  })

  it("a supervisor one provider deeper is a nested host, refused with the three pids named", () => {
    expect(judgeSeatAncestry(harness, providerPid, parents({ [providerPid]: 777 }))).toEqual({
      kind: "nested",
      reason:
        "refused to act as this seat's supervisor: its provider 50 is not a direct child of the seat's harness 4321; " +
        "the provider's parent is 777 (29567)",
    })
  })

  it("the relation is exact: a supervisor whose own parent is the declared harness is refused too", () => {
    expect(judgeSeatAncestry(providerPid, providerPid, parents({ [providerPid]: 9 })).kind).toBe("nested")
  })

  it("a launch that declares no harness is unchanged and reads no process", () => {
    let reads = 0
    const parentOf = (): ParentPidReading => {
      reads += 1
      return { ppid: 777 }
    }
    expect(judgeSeatAncestry(null, providerPid, parentOf)).toEqual({ kind: "seat" })
    expect(reads).toBe(0)
  })

  it("a provider whose parent cannot be read fails open with a warning naming why", () => {
    expect(judgeSeatAncestry(harness, providerPid, parents({}))).toEqual({
      kind: "unmeasured",
      warning:
        "tribe plugin supervisor: could not read the parent of provider 50 (/proc/50/stat is unreadable (ENOENT)); " +
        "acting as this launch's supervisor without the nested-host check (29567)",
    })
  })
})
