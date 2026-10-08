/**
 * Importing a CLI or daemon module does nothing; main(argv) runs it, and the file runs it only as the process entry
 * (hh #26691, @cto 2259658a). A package's fresh consumer imports every export, and an export that acts on import
 * runs the CLI against the importer's argv: under Bun, `import("tribe-wire/cli")` printed the usage and exited 1.
 *
 * @failure  importing tribe-wire/cli or the daemon runs it against the importer's argv, or main exits the process
 *           instead of answering an exit code
 * @level    l2 - a real Bun child imports each module with a stray argv, as a fresh consumer probe does
 * @consumer packages/wire/src/cli.ts, packages/daemon/src/daemon.ts, packages/wire/src/lib/entry-module.ts
 * @testonly none
 */

import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = resolve(HERE, "../src/cli.ts")
const DAEMON = resolve(HERE, "../../daemon/src/daemon.ts")
const BUN_BIN = process.env.BUN_EXECUTABLE ?? "bun"

/** Import `module` in a fresh Bun whose argv carries a stray argument, as a consumer probe's does. */
function importIn(module: string, script: string) {
  return spawnSync(
    BUN_BIN,
    ["--eval", `const m = await import(${JSON.stringify(module)}); ${script}`, '["stray","argv"]'],
    { encoding: "utf8", input: "", timeout: 30_000 },
  )
}

describe("the CLI and daemon modules act only when called", () => {
  it("importing tribe-wire's cli prints nothing, exits 0 and exports main", () => {
    const result = importIn(CLI, "process.stdout.write(typeof m.main)")
    expect(result.stderr).toBe("")
    expect(result.stdout).toBe("function")
    expect(result.status).toBe(0)
  })

  it("main(argv) answers --version with exit code 0 without exiting the process", () => {
    const result = importIn(
      CLI,
      'const code = await m.main(["bun", "tribe-wire", "--version"]); process.stdout.write("\\ncode=" + code)',
    )
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toMatch(/^tribe-wire \d+\.\d+\.\d+\+\S+\n\ncode=0$/)
  })

  it("main(argv) answers an unknown command with Commander's exit code instead of exiting", () => {
    const result = importIn(
      CLI,
      'const code = await m.main(["bun", "tribe-wire", "no-such-verb"]); process.stdout.write("code=" + code)',
    )
    expect(result.status).toBe(0)
    expect(result.stdout).toBe("code=1")
    expect(result.stderr).toContain("no-such-verb")
  })

  it("importing the daemon starts nothing and exports main", () => {
    const result = importIn(DAEMON, "process.stdout.write(typeof m.main)")
    expect(result.stderr).toBe("")
    expect(result.stdout).toBe("function")
    expect(result.status).toBe(0)
  })

  it("the daemon's main refuses an argv that is not process.argv, by name", () => {
    const result = importIn(DAEMON, 'await m.main(["bun", "daemon.ts", "doctor"])')
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("TRIBE_DAEMON_ARGV")
  })

  it("doctor rejects an unknown flag before collecting host sections", () => {
    const result = importIn(
      CLI,
      'const code = await m.main(["bun", "tribe-wire", "doctor", "--no-such-doctor-option"], { doctorSections: async () => { process.stdout.write("COLLECTED"); return [] } }); process.stdout.write("code=" + code)',
    )
    expect(result.status).toBe(0)
    expect(result.stdout).toBe("code=1")
    expect(result.stderr).toContain("--no-such-doctor-option")
  })

  it("retired daemon doctor names Wire and exits before creating a daemon socket", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "tribe-retired-doctor-"))
    const socketPath = resolve(dir, "tribe.sock")
    try {
      const result = spawnSync(BUN_BIN, [DAEMON, "doctor", "--json"], {
        cwd: dir,
        env: { ...process.env, HOME: dir, TRIBE_SOCKET: socketPath, TRIBE_NO_AUTOSTART: "1" },
        encoding: "utf8",
        input: "",
        timeout: 5_000,
      })
      expect(result.status, result.stderr).toBe(2)
      expect(result.stdout).toBe("")
      expect(result.stderr).toContain("tribe-wire doctor")
      expect(existsSync(socketPath)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
