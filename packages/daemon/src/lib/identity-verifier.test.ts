/**
 * The identity-verifier load contract (25074 3b, @cto 4a194bbf): the daemon refuses startup, naming the path, for a
 * module it cannot use, and a verdict outside the contract is a fault, never read as "unreadable".
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import {
  boundedIdentityVerifier,
  displacementRule,
  IdentityVerdictUndecided,
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
      expect(() => verifier.readIncidentPolicy!()).toThrow(`incident policy ${path}`)
    },
  )

  it("refuses changed policy bytes instead of continuing with the previously loaded grant", async () => {
    const source = `export const IDENTITY_VERIFIER_INTERFACE = 1
      export async function verifyIdentity() { return { result: "absent" } }
      export const INCIDENT_POLICY = { emitters: ['longproc-reading'], authorize: () => true }`
    const path = moduleAt("policy-changed.ts", source)
    const verifier = await loadIdentityVerifier(path)
    expect(
      verifier.readIncidentPolicy!().authorize(
        { result: "verified", actor: "longproc-reading", kind: "service", sid: "s" },
        "longproc-reading",
        "read",
      ),
    ).toBe(true)
    writeFileSync(path, source + "\n// changed policy bytes")
    expect(() => verifier.readIncidentPolicy!()).toThrow(`incident policy ${path}`)
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
    const first = wrapped.verify("tok")
    await expect(first).rejects.toBeInstanceOf(IdentityVerdictUndecided)
    await expect(first).rejects.toThrow(/undecided/)
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(calls).toBe(1)
    probe.resolve(verified)
    await new Promise((resolve) => setTimeout(resolve, 0))
    await expect(wrapped.verify("tok")).resolves.toEqual(verified)
    expect(calls).toBe(1)
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
