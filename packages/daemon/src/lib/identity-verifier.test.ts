/**
 * The identity-verifier load contract (25074 3b, @cto 4a194bbf): the daemon refuses startup, naming the path, for a
 * module it cannot use, and a verdict outside the contract is a fault, never read as "unreadable".
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it, vi } from "vitest"
import {
  boundedIdentityVerifier,
  displacementRule,
  loadIdentityVerifier,
  sessionAuthority,
  type IdentityVerdict,
  type LoadedIdentityVerifier,
} from "./identity-verifier.ts"

const dir = mkdtempSync(join(tmpdir(), "tribe-identity-verifier-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function moduleAt(name: string, source: string): string {
  const path = join(dir, name)
  writeFileSync(path, source)
  return path
}

describe("loadIdentityVerifier", () => {
  /** @failure A policy that faulted at boot is refused FOREVER, so a landing that repairs it never takes effect
   *          without a daemon restart.
   * @level   l2
   * @consumer Incident policy recovery after a landing (28921 review).
   */
  it("recovers incident policy on the next call when a promotion repairs a policy that faulted at boot", async () => {
    const path = moduleAt(
      "policy-repair.ts",
      `export const IDENTITY_VERIFIER_INTERFACE = 1
       export async function verifyIdentity() { return { result: "absent" } }
       export const INCIDENT_POLICY = { emitters: ["workmon"], authorize: true }`,
    )
    const verifier = await loadIdentityVerifier(path)
    const broken = verifier.readIncidentPolicy!()
    expect(broken.fault).toContain(`incident policy ${path}`)
    // Membership and the verdict come from ONE fresh answer (28921 review), so a broken policy refuses the
    // OPERATION by name instead of answering a list that could grant it.
    await expect(
      broken.authorize({ result: "verified", actor: "workmon", kind: "service", sid: "sid" }, "workmon", "read"),
    ).rejects.toThrow(`incident policy ${path}`)

    // The promotion repairs the module at the path the daemon already holds; the daemon does not restart.
    writeFileSync(
      path,
      `export const IDENTITY_VERIFIER_INTERFACE = 1
       export async function verifyIdentity() { return { result: "absent" } }
       export const INCIDENT_POLICY = {
         emitters: ["workmon"],
         authorize: (identity, emitter) => identity.actor === emitter,
       }`,
    )
    const repaired = verifier.readIncidentPolicy!()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      expect(
        await repaired.authorize(
          { result: "verified", actor: "workmon", kind: "service", sid: "sid" },
          "workmon",
          "read",
        ),
      ).toEqual({ allow: true, emitters: ["workmon"] })
      expect(warn.mock.calls).toEqual([
        [
          expect.stringMatching(/WARN tribe:identity-verifier$/),
          expect.stringContaining("its incident policy now names workmon where this daemon cached  at boot"),
        ],
      ])
    } finally {
      warn.mockRestore()
    }
    // The successful fresh answer IS what clears the boot fault: a repaired policy stops being reported broken.
    expect(repaired.fault).toBeUndefined()
  })

  /** @failure A policy that breaks AFTER boot refuses grants while the health line still reads healthy, because a
   *          fault is only ever cleared from a successful call and never recorded from a failing one.
   * @level   l2
   * @consumer The incident policy health line across a landing (28921 review, @cto SHOULD 1).
   */
  it("records a policy fault that appears AFTER boot, so health never reads healthy while grants refuse", async () => {
    const path = moduleAt(
      "policy-breaks-later.ts",
      `export const IDENTITY_VERIFIER_INTERFACE = 1
       export async function verifyIdentity() { return { result: "absent" } }
       export const INCIDENT_POLICY = {
         emitters: ["workmon"],
         authorize: (identity, emitter) => identity.actor === emitter,
       }`,
    )
    const verifier = await loadIdentityVerifier(path)
    const policy = verifier.readIncidentPolicy!()
    expect(policy.fault).toBeUndefined()
    expect(
      await policy.authorize({ result: "verified", actor: "workmon", kind: "service", sid: "sid" }, "workmon", "read"),
    ).toEqual({ allow: true, emitters: ["workmon"] })

    // The landing breaks the module at the path the daemon already holds; the daemon does not restart.
    writeFileSync(
      path,
      `export const IDENTITY_VERIFIER_INTERFACE = 1
       export async function verifyIdentity() { return { result: "absent" } }
       export const INCIDENT_POLICY = { emitters: ["workmon"], authorize: true }`,
    )
    await expect(
      policy.authorize({ result: "verified", actor: "workmon", kind: "service", sid: "sid" }, "workmon", "read"),
    ).rejects.toThrow(`incident policy ${path}`)
    // The refusal must be visible to the health line, not only to the caller that refused.
    expect(policy.fault).toContain(`incident policy ${path}`)
  })

  /** @failure Membership is decided from the emitter list read at boot, so a landing that ADDS an emitter is
   *          refused before the current module is ever asked.
   * @level   l2
   * @consumer The incident refusal path across a promotion (28921 review).
   */
  it("adopts an emitter ADDED by a promotion, so membership is never decided from the boot snapshot", async () => {
    const current = join(dir, "membership-pointer")
    const write = (landing: string, emitters: readonly string[]) => {
      mkdirSync(join(dir, landing), { recursive: true })
      writeFileSync(
        join(dir, landing, "verifier.ts"),
        `export const IDENTITY_VERIFIER_INTERFACE = 1
         export async function verifyIdentity() { return { result: "absent" } }
         export const INCIDENT_POLICY = {
           emitters: ${JSON.stringify(emitters)},
           authorize: (identity, emitter) => identity.actor === emitter,
         }`,
      )
    }
    write("membership-a", ["longproc-reading"])
    write("membership-b", ["longproc-reading", "coordination-watch"])
    symlinkSync(join(dir, "membership-a"), current)

    const verifier = await loadIdentityVerifier(join(current, "verifier.ts"))
    const policy = verifier.readIncidentPolicy!()
    expect(policy.emitters).toEqual(["longproc-reading"])

    // The promotion: the pointer moves. The boot snapshot is now stale and must not decide membership.
    unlinkSync(current)
    symlinkSync(join(dir, "membership-b"), current)

    // The SAME fresh answer carries the current list and the verdict (28921 review).
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      expect(
        await policy.authorize(
          { result: "verified", actor: "coordination-watch", kind: "service", sid: "sid" },
          "coordination-watch",
          "read",
        ),
      ).toEqual({ allow: true, emitters: ["longproc-reading", "coordination-watch"] })
      expect(warn.mock.calls).toEqual([
        [
          expect.stringMatching(/WARN tribe:identity-verifier$/),
          expect.stringContaining(
            "its incident policy now names longproc-reading, coordination-watch where this daemon cached longproc-reading at boot",
          ),
        ],
      ])
    } finally {
      warn.mockRestore()
    }
    expect(policy.emitters).toEqual(["longproc-reading", "coordination-watch"])
  })

  /** @failure Broken incident policy stops identity verification or silently grants managed access.
   * @level l1
   * @consumer Managed incident operations and unrelated Tribe traffic (28044 AC1).
   */
  it.each([
    ["absent", ""],
    ["malformed", "export const INCIDENT_POLICY = { emitters: ['longproc-reading'], authorize: true }"],
  ])(
    "keeps identity verification available with %s incident policy and names the policy fault",
    async (name, policy) => {
      const path = moduleAt(
        `policy-${name}.ts`,
        `export const IDENTITY_VERIFIER_INTERFACE = 1
      export async function verifyIdentity() { return { result: "absent" } }
      ${policy}`,
      )
      const verifier = await loadIdentityVerifier(path)
      expect(await verifier.verify("ordinary-token")).toEqual({ result: "absent" })
      // 28921 review: the fault is HEALTH data on the accessor and is named on the OPERATION path, so a policy
      // repaired at the next landing recovers on the next call instead of being refused forever.
      const loadedPolicy = verifier.readIncidentPolicy!()
      expect(loadedPolicy.emitters).toEqual([])
      expect(loadedPolicy.fault).toContain(`incident policy ${path}`)
      await expect(
        loadedPolicy.authorize(
          { result: "verified", actor: "longproc-reading", kind: "service", sid: "s" },
          "longproc-reading",
          "read",
        ),
      ).rejects.toThrow(`incident policy ${path}`)
    },
  )

  /** @failure The daemon runs the verifier it imported at boot, so a promotion that changes the verifier never
   *          reaches the next connect without a wire restart — the 28921 defect, and the second undeclared
   *          dependency ("its argv-named verifier") that made wire's `ag` pin load-bearing.
   * @level   l2
   * @consumer The promotion gate: a landing that moves only the verifier must not need a wire relaunch.
   */
  it("adopts a changed verifier on the NEXT CALL, through a promotion pointer, with no restart", async () => {
    const current = join(dir, "pointer")
    const write = (landing: string, token: string, emitter: string) => {
      mkdirSync(join(dir, landing), { recursive: true })
      writeFileSync(
        join(dir, landing, "verifier.ts"),
        `export const IDENTITY_VERIFIER_INTERFACE = 1
         export async function verifyIdentity(token) {
           return token === ${JSON.stringify(token)}
             ? { result: "verified", actor: "@dev/7", sid: "sid-${landing}" }
             : { result: "absent" }
         }
         export const INCIDENT_POLICY = { emitters: [${JSON.stringify(emitter)}], authorize: () => true }`,
      )
    }
    write("landing-a", "token-a", "workmon")
    write("landing-b", "token-b", "longproc-reading")
    symlinkSync(join(dir, "landing-a"), current)

    const verifier = await loadIdentityVerifier(join(current, "verifier.ts"))
    expect(await verifier.verify("token-a")).toMatchObject({ result: "verified", sid: "sid-landing-a" })
    expect(await verifier.verify("token-b")).toEqual({ result: "absent" })

    // The promotion: the pointer moves. The daemon does not restart and nothing re-imports in place.
    unlinkSync(current)
    symlinkSync(join(dir, "landing-b"), current)

    expect(await verifier.verify("token-a")).toEqual({ result: "absent" })
    expect(await verifier.verify("token-b")).toMatchObject({ result: "verified", sid: "sid-landing-b" })
  })

  /** @failure An authorization decision is served from a copy of the host policy read when the daemon started.
   * @level   l1
   * @consumer The daemon's per-operation incident authorization (28044 AC1).
   */
  it("decides authorization in the CURRENT module and reports the emitter list it actually used", async () => {
    const path = moduleAt(
      "policy-current.ts",
      `export const IDENTITY_VERIFIER_INTERFACE = 1
       export async function verifyIdentity() { return { result: "absent" } }
       export const INCIDENT_POLICY = {
         emitters: ["longproc-reading"],
         authorize: (identity, emitter, operation) => identity.actor === emitter && operation === "read",
       }`,
    )
    const verifier = await loadIdentityVerifier(path)
    const policy = verifier.readIncidentPolicy!()
    expect(policy.emitters).toEqual(["longproc-reading"])
    // Membership and the verdict arrive in the SAME answer (28921 review), so a caller never reconciles a grant
    // against a list read at a different moment.
    const grant = (
      identity: Parameters<typeof policy.authorize>[0],
      operation: Parameters<typeof policy.authorize>[2],
    ) => policy.authorize(identity, "longproc-reading", operation)
    expect(await grant({ result: "verified", actor: "longproc-reading", kind: "service", sid: "s" }, "read")).toEqual({
      allow: true,
      emitters: ["longproc-reading"],
    })
    expect(
      (await grant({ result: "verified", actor: "longproc-reading", kind: "service", sid: "s" }, "raise")).allow,
    ).toBe(false)
    expect((await grant({ result: "verified", actor: "someone-else", sid: "s" }, "read")).allow).toBe(false)
  })

  it("reports a verifier that cannot even load as a named fault, never as an absent verdict", async () => {
    const path = join(dir, "not-a-module.ts")
    writeFileSync(path, "this is not TypeScript at all !!!\n")
    await expect(loadIdentityVerifier(path)).rejects.toThrow(`--identity-verifier ${path}: failed to load:`)
  })

  /** @failure Managed emitter authorization loses the verified service kind.
   * @level l1
   * @consumer The daemon's per-operation incident authorization (28044 AC1).
   * Existing interface-1 coverage exercises only seat verdicts without kind.
   */
  it("preserves verified service kind through the existing module boundary", async () => {
    const path = moduleAt(
      "service-kind.ts",
      `export const IDENTITY_VERIFIER_INTERFACE = 1
       export async function verifyIdentity() {
         return { result: "verified", actor: "longproc-reading", kind: "service", sid: "svc-1", gen: 2 }
       }`,
    )
    const verifier = await loadIdentityVerifier(path)
    expect(await verifier.verify("service-token")).toEqual({
      result: "verified",
      actor: "longproc-reading",
      kind: "service",
      sid: "svc-1",
      gen: 2,
    })
  })

  /** @failure The verifier child returns an observed Ag incarnation, but the daemon drops its PID or kernel birth and
   *          cannot distinguish a resumed owner from a recycled PID before a successor notice.
   * @level l2
   * @consumer Verified-successor yield admission (29262 step 2).
   * The existing kind/gen row never carries process identity across this child boundary.
   */
  it("preserves optional observed Ag incarnation through the verifier child", async () => {
    const path = moduleAt(
      "observed-ag-incarnation.ts",
      `export const IDENTITY_VERIFIER_INTERFACE = 1
       export async function verifyIdentity() {
         return {
           result: "verified", actor: "@dev/7", sid: "seat-7", gen: 4,
           observedAgPid: 4107, observedAgStartTime: "71990912",
         }
       }`,
    )
    const verifier = await loadIdentityVerifier(path)
    expect(await verifier.verify("successor-token")).toEqual({
      result: "verified",
      actor: "@dev/7",
      sid: "seat-7",
      gen: 4,
      observedAgPid: 4107,
      observedAgStartTime: "71990912",
    })
  })

  it("loads a module that speaks interface 1 and passes its verdicts through", async () => {
    const path = moduleAt(
      "good.ts",
      `export const IDENTITY_VERIFIER_INTERFACE = 1
       export async function verifyIdentity(token) {
         return token === "t" ? { result: "verified", actor: "@dev/7", sid: "s1" } : { result: "absent" }
       }`,
    )
    const verifier = await loadIdentityVerifier(path)
    expect(verifier.path).toBe(path)
    expect(await verifier.verify("t")).toEqual({ result: "verified", actor: "@dev/7", sid: "s1" })
    expect(await verifier.verify("other")).toEqual({ result: "absent" })
  })

  it("refuses naming the path for a relative path, a missing file, a wrong interface or no function", async () => {
    await expect(loadIdentityVerifier("tools/verifier.ts")).rejects.toThrow(
      "--identity-verifier tools/verifier.ts: must be an absolute path",
    )
    const missing = join(dir, "missing.ts")
    await expect(loadIdentityVerifier(missing)).rejects.toThrow(`--identity-verifier ${missing}: does not exist`)
    const wrong = moduleAt(
      "wrong-interface.ts",
      "export const IDENTITY_VERIFIER_INTERFACE = 2\nexport async function verifyIdentity() {}",
    )
    await expect(loadIdentityVerifier(wrong)).rejects.toThrow(
      `--identity-verifier ${wrong}: exports IDENTITY_VERIFIER_INTERFACE 2, this daemon speaks 1`,
    )
    const noFunction = moduleAt("no-function.ts", "export const IDENTITY_VERIFIER_INTERFACE = 1")
    await expect(loadIdentityVerifier(noFunction)).rejects.toThrow(
      `--identity-verifier ${noFunction}: exports no verifyIdentity function`,
    )
    const throwing = moduleAt("throws-at-load.ts", 'throw new Error("HAB_SESSION_HABITAT_ROOT is unset")')
    await expect(loadIdentityVerifier(throwing)).rejects.toThrow(
      `--identity-verifier ${throwing}: failed to load: HAB_SESSION_HABITAT_ROOT is unset`,
    )
  })

  it("a verdict outside the contract throws, so register refuses it as a verifier fault", async () => {
    const path = moduleAt(
      "bad-verdict.ts",
      `export const IDENTITY_VERIFIER_INTERFACE = 1
       export async function verifyIdentity() { return { result: "verified", actor: "@dev/7" } }`,
    )
    const verifier = await loadIdentityVerifier(path)
    await expect(verifier.verify("t")).rejects.toThrow(
      `identity verifier ${path} returned a verdict outside the contract`,
    )
    // A partial or malformed process incarnation is an explicit contract fault, not a verified identity
    // with silently discarded process evidence.
    for (const [name, fields] of [
      ["missing-birth", `observedAgPid: 4107`],
      ["invalid-pid", `observedAgPid: 0, observedAgStartTime: "71990912"`],
      ["empty-birth", `observedAgPid: 4107, observedAgStartTime: ""`],
    ] as const) {
      const invalidPath = moduleAt(
        `${name}.ts`,
        `export const IDENTITY_VERIFIER_INTERFACE = 1
         export async function verifyIdentity() {
           return { result: "verified", actor: "@dev/7", sid: "seat-7", ${fields} }
         }`,
      )
      const invalid = await loadIdentityVerifier(invalidPath)
      await expect(invalid.verify("t")).rejects.toThrow(
        `identity verifier ${invalidPath} returned a verdict outside the contract`,
      )
    }
  })
})

/**
 * The bounded verifier (28927, @cto f7046649): the daemon never waits on a raw liveness probe on the
 * dispatcher path. One row per pin of the ruling.
 */
describe("boundedIdentityVerifier", () => {
  const verified: IdentityVerdict = { result: "verified", actor: "@dev/7", sid: "s1" }

  function stub(verify: LoadedIdentityVerifier["verify"]): LoadedIdentityVerifier {
    return { path: "/stub/verifier.ts", suppliesGen: false, verify }
  }

  function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((res) => {
      resolve = res
    })
    return { promise, resolve }
  }

  /** @failure One seat's silent control socket stalls every seat's calls (28927 pin 1).
   * @level l1 @consumer The daemon dispatcher (one-shot and register verification). */
  it("a slow probe for one seat does not delay another seat's call", async () => {
    const slow = deferred<IdentityVerdict>()
    const wrapped = boundedIdentityVerifier(
      stub(async (token) => (token === "seat-slow" ? slow.promise : verified)),
      { waitMs: 5_000 },
    )
    const slowCall = wrapped.verify("seat-slow")
    await expect(wrapped.verify("seat-fast")).resolves.toEqual(verified)
    slow.resolve(verified)
    await expect(slowCall).resolves.toEqual(verified)
  })

  /** @failure Every call pays a fresh 5 s probe for a seat verified seconds ago (28927 pin 2).
   * @level l1 @consumer The daemon dispatcher (one-shot and register verification). */
  it("two calls inside the verdict TTL spawn one probe", async () => {
    let calls = 0
    let t = 0
    const wrapped = boundedIdentityVerifier(
      stub(async () => {
        calls += 1
        return verified
      }),
      { ttlMs: 30_000, now: () => t },
    )
    await expect(wrapped.verify("tok")).resolves.toEqual(verified)
    t = 29_999
    await expect(wrapped.verify("tok")).resolves.toEqual(verified)
    expect(calls).toBe(1)
    t = 30_000
    await expect(wrapped.verify("tok")).resolves.toEqual(verified)
    expect(calls).toBe(2)
  })

  /** @failure Concurrent calls for one seat each spawn their own probe (28927 pin 3).
   * @level l1 @consumer The daemon dispatcher (one-shot and register verification). */
  it("concurrent calls for one seat share the probe in flight", async () => {
    let calls = 0
    const probe = deferred<IdentityVerdict>()
    const wrapped = boundedIdentityVerifier(
      stub(async () => {
        calls += 1
        return probe.promise
      }),
      { waitMs: 5_000 },
    )
    const pending = [wrapped.verify("tok"), wrapped.verify("tok"), wrapped.verify("tok")]
    expect(calls).toBe(1)
    probe.resolve(verified)
    await expect(Promise.all(pending)).resolves.toEqual([verified, verified, verified])
    expect(calls).toBe(1)
  })

  /** @failure The call path waits the probe's full 5 s, or worse, proceeds as if verified (28927 pin 4).
   * @level l1 @consumer The daemon dispatcher (one-shot and register verification). */
  it("past the bounded wait the call is answered undecided at once, the probe lands in the background, and only its verdict ever verifies", async () => {
    let calls = 0
    const probe = deferred<IdentityVerdict>()
    const wrapped = boundedIdentityVerifier(
      stub(async () => {
        calls += 1
        return probe.promise
      }),
      { waitMs: 30 },
    )
    const started = Date.now()
    await expect(wrapped.verify("tok")).resolves.toEqual({ result: "undecided", reason: "no verdict within 30ms" })
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(calls).toBe(1)
    probe.resolve(verified)
    await new Promise((resolve) => setTimeout(resolve, 0))
    await expect(wrapped.verify("tok")).resolves.toEqual(verified)
    expect(calls).toBe(1)
  })

  /** @failure A cold probe at the measured tail (~600 ms: supervisor-socket leg under load, right after a
   * generation start) is refused undecided even though its verdict lands well inside every downstream
   * budget (28947). @level l1 @consumer The daemon dispatcher (one-shot and register verification). */
  it("the default wait serves a probe that lands at ~600ms (28947)", async () => {
    const wrapped = boundedIdentityVerifier(
      stub(async () => {
        await new Promise((resolve) => setTimeout(resolve, 600))
        return verified
      }),
    )
    await expect(wrapped.verify("tok")).resolves.toEqual(verified)
  })

  /** @failure The bound is revised from a ratio to a budget instead of the cold tail actually observed:
   * a probe that outlived the wait lands its verdict in the cache with no record of how long it took
   * (28947, @cto must). @level l1 @consumer The daemon composition's info log. */
  it("a probe that outlived the wait reports its eventual duration and verdict kind when it lands (28947)", async () => {
    const landed: Array<{ elapsedMs: number; result: IdentityVerdict["result"] }> = []
    const probe = deferred<IdentityVerdict>()
    const wrapped = boundedIdentityVerifier(
      stub(async () => probe.promise),
      {
        waitMs: 30,
        onOutlivedProbe: (info) => landed.push(info),
      },
    )
    await expect(wrapped.verify("tok")).resolves.toEqual({ result: "undecided", reason: "no verdict within 30ms" })
    expect(landed).toEqual([])
    probe.resolve(verified)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(landed).toHaveLength(1)
    expect(landed[0]?.result).toBe("verified")
    expect(landed[0]?.elapsedMs).toBeGreaterThanOrEqual(30)
    // The next call serves the landed verdict from cache; nothing outlived again.
    await expect(wrapped.verify("tok")).resolves.toEqual(verified)
    expect(landed).toHaveLength(1)
  })
})

describe("session authority", () => {
  it("reads verified or claimed from the session row's sid alone (3d-3)", () => {
    expect(sessionAuthority({ identity_sid: "s1" })).toBe("verified")
    expect(sessionAuthority({ identity_sid: null })).toBe("claimed")
  })

  it("bars a claimed registration from a verified holder; every other pairing is allowed (3d-3)", () => {
    expect(displacementRule("verified", "claimed")).toBe("refused")
    expect(displacementRule("claimed", "claimed")).toBe("allowed")
    expect(displacementRule("claimed", "verified")).toBe("allowed")
    expect(displacementRule("verified", "verified")).toBe("allowed")
  })
})
