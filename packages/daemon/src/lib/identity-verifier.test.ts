/**
 * The identity-verifier load contract (25074 3b, @cto 4a194bbf): the daemon refuses startup, naming the path, for a
 * module it cannot use, and a verdict outside the contract is a fault, never read as "unreadable".
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { connect, createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it, vi } from "vitest"
import { addWriter, getLogLevel, setLogLevel } from "loggily"
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

  /** @failure A socket dispatcher delays the deadline callback until after the real child has exited, but the
   * caller returns undecided before Bun delivers its exit notification (30030).
   * @level l2 @consumer Managed registration, bootstrap and inbox-wait on Bun/Linux.
   * Existing deferred-promise tests cannot witness kernel exit before JavaScript completion delivery. */
  it.skipIf(process.platform !== "linux" || process.versions.bun === undefined).each([
    { name: "verified", action: `return ${JSON.stringify(verified)}`, error: null },
    { name: "nonzero", action: "process.exit(7)", error: "child exited 7" },
    { name: "malformed", action: "return { result: 'made-up' }", error: "outside the contract" },
    {
      name: "oversized",
      action: `return { result: 'verified', actor: 'x'.repeat(70000), sid: 's1' }`,
      error: "exceeded 65536 bytes",
    },
  ])(
    "uses the real exited verifier when a socket callback delays the 1000ms deadline ($name)",
    async ({ name, action, error }) => {
      const pidPath = join(dir, `deadline-child-${name}.pid`)
      const path = moduleAt(
        `deadline-child-${name}.ts`,
        `
        import { writeFileSync } from "node:fs"
        export const IDENTITY_VERIFIER_INTERFACE = 1
        export async function verifyIdentity() {
          writeFileSync(${JSON.stringify(pidPath)}, String(process.pid))
          ${action}
        }
      `,
      )
      const loaded = await loadIdentityVerifier(path)
      const wrapped = boundedIdentityVerifier(loaded)
      const completionLog = vi.spyOn(console, "error").mockImplementation(() => {})
      const previousLevel = getLogLevel()
      setLogLevel("info")
      const completionEvents: unknown[] = []
      const unsubscribe = addWriter((_formatted, _level, _namespace, event) => {
        if (
          event.namespace === "tribe:identity-verifier" &&
          "message" in event &&
          event.message === "verifier exited by deadline callback"
        ) {
          completionEvents.push(event)
        }
      })
      let completionDelivered = false
      let deliveredDuringBlock = false
      let witnessedZombie = false
      const result = Promise.withResolvers<{ verdict: IdentityVerdict } | { error: unknown }>()
      const server = createServer((socket) => {
        socket.once("data", () => {
          const pending = wrapped.verify("deadline-token")
          void pending.then(
            () => {
              completionDelivered = true
            },
            () => {
              completionDelivered = true
            },
          )
          // Reproduce the poll/dispatcher block, not a timer callback (which delivers child exit first on Bun).
          // The 1200ms block crosses the unchanged caller bound and remains below the runner's 6000ms bound.
          const until = performance.now() + 1200
          const cap = performance.now() + 5500
          while (performance.now() < cap && (performance.now() < until || !witnessedZombie)) {
            if (!witnessedZombie && existsSync(pidPath)) {
              const text = readFileSync(pidPath, "utf8")
              // Creation and writing are separate syscalls: an empty/partial readiness file is not PID zero.
              if (!/^[1-9]\d*$/u.test(text)) continue
              const pid = Number(text)
              try {
                const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
                witnessedZombie = stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ")
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
                // No zombie witness yet; keep the readiness wait, never certify exit from absence.
              }
            }
          }
          deliveredDuringBlock = completionDelivered
          socket.end()
          void pending.then(
            (verdict) => result.resolve({ verdict }),
            (error) => result.resolve({ error }),
          )
        })
      })
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
      const address = server.address()
      if (address === null || typeof address === "string") throw new Error("test server has no TCP address")
      const client = connect(address.port, "127.0.0.1", () => client.write("probe"))
      try {
        const outcome = await result.promise
        expect(witnessedZombie, `requires Bun ${process.versions.bun} exited-but-undelivered child`).toBe(true)
        expect(deliveredDuringBlock).toBe(false)
        expect(completionDelivered).toBe(true)
        expect(completionEvents).toHaveLength(1)
        expect(completionEvents[0]).toMatchObject({ props: { elapsedMs: expect.any(Number), evidence: "zombie" } })
        if (error === null) expect(outcome).toEqual({ verdict: verified })
        else {
          expect(outcome).toHaveProperty("error")
          expect("error" in outcome && String(outcome.error)).toContain(error)
        }
      } finally {
        completionLog.mockRestore()
        unsubscribe()
        setLogLevel(previousLevel)
        client.destroy()
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    },
    15_000,
  )

  /** @failure The production loader loses its explicit completion channel, silently restoring deadline races.
   * @level l2 @consumer The real bounded verifier, whose custom/stub adapters remain untracked. */
  it("the production verifier exposes a tracked call that returns its checked promise and completion reader", async () => {
    const path = moduleAt(
      "tracked-call.ts",
      `export const IDENTITY_VERIFIER_INTERFACE = 1
      export async function verifyIdentity() { await Bun.sleep(100); return ${JSON.stringify(verified)} }`,
    )
    const loaded = await loadIdentityVerifier(path)
    const symbol = Object.getOwnPropertySymbols(loaded).find((key) => key.description === "trackedIdentityVerification")
    expect(symbol, "production loader must expose its explicit private tracked call").toBeTypeOf("symbol")
    const start = Reflect.get(loaded, symbol!) as (token: string) => {
      promise: Promise<IdentityVerdict>
      readCompletion: () => { state: string }
    }
    const tracked = start("tracked-token")
    expect(tracked.readCompletion().state).toBe("running")
    await expect(tracked.promise).resolves.toEqual(verified)
    expect(tracked.readCompletion().state).toBe("exited")
  })

  /** @failure Checking process completion turns a still-running real verifier into a grant or drops its later cache.
   * @level l2 @consumer Cold identity calls whose child legitimately outlives the caller. */
  it("a real running verifier remains undecided and later caches only its checked verdict", async () => {
    const path = moduleAt(
      "running-child.ts",
      `export const IDENTITY_VERIFIER_INTERFACE = 1
      export async function verifyIdentity() { await Bun.sleep(150); return ${JSON.stringify(verified)} }`,
    )
    const loaded = await loadIdentityVerifier(path)
    const landed = Promise.withResolvers<void>()
    const wrapped = boundedIdentityVerifier(loaded, { waitMs: 30, onOutlivedProbe: () => landed.resolve() })
    await expect(wrapped.verify("running-token")).resolves.toMatchObject({
      result: "undecided",
      reason: expect.stringContaining("still running"),
    })
    await landed.promise
    await expect(wrapped.verify("running-token")).resolves.toEqual(verified)
  })

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
