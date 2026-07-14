/**
 * Vendor-local runtime identity helpers (@km/infra/20359). `formatRuntimeId` is
 * the pure core (`<version>+<sha>`, never a fabricated sha); `tribeWireRuntimeId`
 * composes the wire package version with a live git read.
 */

import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { formatRuntimeId, tribeWireRuntimeId, wireVersion } from "../src/runtime-id.ts"

const tribeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")

function cleanGitEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")))
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: cleanGitEnv(),
  }).trim()
}

function pollutedGitEnv(fakeRepo: string): NodeJS.ProcessEnv {
  return {
    ...cleanGitEnv(),
    GIT_DIR: join(fakeRepo, ".git"),
    GIT_WORK_TREE: fakeRepo,
    GIT_INDEX_FILE: join(fakeRepo, ".git", "index"),
    // An extra redirector proves callers must scrub the whole GIT_* namespace,
    // not just the three commonly encountered repository variables.
    GIT_OBJECT_DIRECTORY: join(fakeRepo, ".git", "objects"),
  }
}

describe("formatRuntimeId", () => {
  it("composes `<version>+<sha>`", () => {
    expect(formatRuntimeId("0.1.4", "abc1234")).toBe("0.1.4+abc1234")
  })
  it("null sha → +unknown (loud, never a fabricated sha)", () => {
    expect(formatRuntimeId("0.1.4", null)).toBe("0.1.4+unknown")
  })
})

describe("wireVersion", () => {
  it("reads a real semver from the wire package.json", () => {
    expect(wireVersion()).toMatch(/^\d+\.\d+\.\d+/)
  })
})

describe("tribeWireRuntimeId", () => {
  it("is `<semver>+<sha-or-unknown>` shaped", () => {
    expect(tribeWireRuntimeId()).toMatch(/^\d+\.\d+\.\d+.*\+(?:[0-9a-f]+|unknown)$/)
  })

  it("reports the Tribe source SHA even when the caller exports redirecting GIT_* variables", () => {
    const expectedSha = git(tribeRoot, "rev-parse", "--short", "HEAD")
    const fakeRepo = mkdtempSync(join(tmpdir(), "tribe-runtime-id-pollution-"))
    try {
      git(fakeRepo, "init", "-q")
      git(fakeRepo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-q", "-m", "fake")
      expect(git(fakeRepo, "rev-parse", "--short", "HEAD")).not.toBe(expectedSha)

      const reported = execFileSync(
        process.execPath,
        [
          "-e",
          'import { tribeWireRuntimeId } from "./packages/wire/src/runtime-id.ts"; process.stdout.write(tribeWireRuntimeId())',
        ],
        { cwd: tribeRoot, encoding: "utf8", env: pollutedGitEnv(fakeRepo) },
      )
      expect(reported).toBe(`${wireVersion()}+${expectedSha}`)
    } finally {
      rmSync(fakeRepo, { recursive: true, force: true })
    }
  })
})
