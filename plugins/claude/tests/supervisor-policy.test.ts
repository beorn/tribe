import { describe, expect, it } from "vitest"
import {
  ADAPTER_STABLE_MS,
  evaluateAdapterRestart,
  REEXEC_BACKOFF_MAX_MS,
  LEGACY_PARENT_WARNING,
  PROVIDER_PARENT_REMEDY,
  resolveProviderParentPid,
} from "../supervisor-policy.ts"
import {
  buildPluginAdapterEnvironment,
  PLUGIN_REEXEC_EXIT_CODE,
  PLUGIN_REEXEC_EXIT_CODE_ENV,
} from "../supervisor-environment.ts"

describe("Claude plugin adapter restart budget", () => {
  it("puts the re-exec value in the actual supervised child environment", () => {
    const env = buildPluginAdapterEnvironment({ [PLUGIN_REEXEC_EXIT_CODE_ENV]: "" }, 4321)

    expect(env[PLUGIN_REEXEC_EXIT_CODE_ENV]).toBe(String(PLUGIN_REEXEC_EXIT_CODE))
    expect(env.TRIBE_PLUGIN_ADAPTER_CHILD).toBe("1")
    expect(env.TRIBE_PLUGIN_PROVIDER_PARENT_PID).toBe("4321")
  })

  it("allows a second quick re-exec when two legitimate daemon generations arrive in one restart burst", () => {
    expect(evaluateAdapterRestart(1, 10_000, Number.POSITIVE_INFINITY, 1)).toEqual({
      consecutiveReexecs: 2,
      retry: true,
      retryDelayMs: 500,
    })
  })

  it("keeps non-generation re-exec failures on the one-retry fail-loud path", () => {
    expect(evaluateAdapterRestart(1, 10_000, 1, 1)).toEqual({
      consecutiveReexecs: 2,
      retry: false,
      retryDelayMs: 0,
    })
  })

  it("retries a persistently crashing adapter forever with capped backoff", () => {
    let consecutiveReexecs = 0
    for (let attempt = 1; attempt <= 12; attempt += 1) {
      const decision = evaluateAdapterRestart(consecutiveReexecs, 10_000, Number.POSITIVE_INFINITY, 1)
      expect(decision).toEqual({
        consecutiveReexecs: attempt,
        retry: true,
        retryDelayMs: Math.min(250 * 2 ** (attempt - 1), REEXEC_BACKOFF_MAX_MS),
      })
      consecutiveReexecs = decision.consecutiveReexecs
    }
  })

  it("jitters each retry below the cap without allowing a zero-delay hot loop", () => {
    const low = evaluateAdapterRestart(7, 10_000, Number.POSITIVE_INFINITY, 0)
    const high = evaluateAdapterRestart(7, 10_000, Number.POSITIVE_INFINITY, 1)
    expect(low).toMatchObject({ retry: true, retryDelayMs: REEXEC_BACKOFF_MAX_MS * 0.75 })
    expect(high).toMatchObject({ retry: true, retryDelayMs: REEXEC_BACKOFF_MAX_MS })
  })

  it("re-arms one replacement after a genuinely stable adapter lifetime", () => {
    expect(ADAPTER_STABLE_MS).toBeGreaterThan(60_000)
    expect(evaluateAdapterRestart(1, ADAPTER_STABLE_MS, Number.POSITIVE_INFINITY, 1)).toEqual({
      consecutiveReexecs: 1,
      retry: true,
      retryDelayMs: 250,
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
    ).toBe(4321)
  })

  it("a supplied provider parent with no managed identity at all is an incomplete tuple and throws the remedy", () => {
    expect(() => resolveProviderParentPid({ TRIBE_PLUGIN_PROVIDER_PARENT_PID: "4321" }, self, alive, () => {})).toThrow(
      PROVIDER_PARENT_REMEDY,
    )
  })

  it("a managed launch with no provider parent falls back to the real parent, loudly", () => {
    const warnings: string[] = []
    expect(resolveProviderParentPid({ HAB_ID_TOKEN: "seat-token" }, self, alive, (line) => warnings.push(line))).toBe(
      50,
    )
    expect(warnings).toEqual([LEGACY_PARENT_WARNING])
  })
})
