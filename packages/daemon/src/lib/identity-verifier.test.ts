/**
 * The identity-verifier load contract (25074 3b, @cto 4a194bbf): the daemon refuses startup, naming the path, for a
 * module it cannot use, and a verdict outside the contract is a fault, never read as "unreadable".
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { displacementRefused, loadIdentityVerifier, sessionAuthority } from "./identity-verifier.ts"

const dir = mkdtempSync(join(tmpdir(), "tribe-identity-verifier-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function moduleAt(name: string, source: string): string {
  const path = join(dir, name)
  writeFileSync(path, source)
  return path
}

describe("loadIdentityVerifier", () => {
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

describe("session authority", () => {
  it("reads verified, bearer or claimed from the session row", () => {
    expect(sessionAuthority({ identity_sid: "s1", mailbox_authority_hash: "h" })).toBe("verified")
    expect(sessionAuthority({ identity_sid: null, mailbox_authority_hash: "h" })).toBe("bearer")
    expect(sessionAuthority({ identity_sid: null, mailbox_authority_hash: null })).toBe("claimed")
  })

  it("bars only a claimed registration from displacing a managed holder, until 3c registers the bootstrap by token", () => {
    expect(displacementRefused("verified", "claimed")).toBe(true)
    expect(displacementRefused("bearer", "claimed")).toBe(true)
    expect(displacementRefused("claimed", "claimed")).toBe(false)
    expect(displacementRefused("verified", "bearer")).toBe(false)
    expect(displacementRefused("bearer", "verified")).toBe(false)
  })
})
