/**
 * @failure A launch hands a process `HAB_ID_TOKEN_FILE`, and its token is read from the wrong source — or a named file
 *          that cannot be read is silently treated as "no credential", which is exactly the silent error the estate
 *          forbids (27314 B1, @cto c13452cd).
 * @level   l1 — the wire readers and the filesystem, no daemon
 * @consumer @hh/tooling/27314-secret-printing-guard (B1 step A: accept both names)
 * @testonly none
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { readCredentialFile } from "../src/lib/credential-file.ts"
import { HAB_ID_TOKEN_ENV, HAB_ID_TOKEN_FILE_ENV } from "../src/lib/hab-session-env.ts"
import { readIdentityTokenFromEnvironment, readLaunchIdFromToken } from "../src/lib/identity-token.ts"
import { launchTokenFile } from "./launch-token.ts"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tribe-credential-file-"))
  dirs.push(dir)
  return dir
}

function tempFile(contents: string): string {
  const path = join(tempDir(), "token")
  writeFileSync(path, contents, { mode: 0o600 })
  return path
}

describe("readCredentialFile (27314 B1)", () => {
  test("an unset or blank name is absence, not an error", () => {
    expect(readCredentialFile(undefined)).toBeNull()
    expect(readCredentialFile("")).toBeNull()
    expect(readCredentialFile("   ")).toBeNull()
  })

  test("reads the named file's value, trailing newline trimmed", () => {
    expect(readCredentialFile(tempFile("signed.token.value\n"))).toBe("signed.token.value")
  })

  test("a named file that cannot be read fails loudly by path", () => {
    expect(() => readCredentialFile(join(tmpdir(), "no-such-credential-file-27314"))).toThrow(/unreadable/u)
  })

  test("a named but empty file fails loudly, never reads as no credential", () => {
    expect(() => readCredentialFile(tempFile(""))).toThrow(/empty/u)
    expect(() => readCredentialFile(tempFile("\n  \n"))).toThrow(/empty/u)
  })
})

describe("readIdentityTokenFromEnvironment (27314 B1, accept both)", () => {
  test("prefers the file over the legacy value", () => {
    const path = tempFile("from-file")
    expect(readIdentityTokenFromEnvironment({ [HAB_ID_TOKEN_FILE_ENV]: path, [HAB_ID_TOKEN_ENV]: "from-value" })).toBe(
      "from-file",
    )
  })

  test("falls back to the value while no producer emits the file yet", () => {
    expect(readIdentityTokenFromEnvironment({ [HAB_ID_TOKEN_ENV]: "from-value" })).toBe("from-value")
  })

  test("neither name is null, an empty value is null", () => {
    expect(readIdentityTokenFromEnvironment({})).toBeNull()
    expect(readIdentityTokenFromEnvironment({ [HAB_ID_TOKEN_ENV]: "" })).toBeNull()
  })

  test("a file path that cannot be read fails loudly rather than falling back to the value", () => {
    expect(() =>
      readIdentityTokenFromEnvironment({
        [HAB_ID_TOKEN_FILE_ENV]: join(tmpdir(), "no-such-token-file-27314"),
        [HAB_ID_TOKEN_ENV]: "from-value",
      }),
    ).toThrow(/unreadable/u)
  })

  test("a file-borne launch token still names its launch (the cutover path)", () => {
    expect(readLaunchIdFromToken(launchTokenFile(tempDir(), "launch-27314"))).toBe("launch-27314")
  })
})
