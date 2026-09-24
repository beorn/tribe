/**
 * @failure A seat launch ran `bun install` inside a host checkout on every start and swallowed its
 * stderr and exit code, relinking the host's node_modules under running processes.
 */
import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { safeRemoveSync } from "removely"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

const PLUGIN_ROOT = resolve(import.meta.dirname, "..")
const LAUNCH = join(PLUGIN_ROOT, "launch.sh")

let dir: string
let log: string

function fakeBun(probeExit: number, installExit: number): string {
  const bin = join(dir, "bin")
  mkdirSync(bin, { recursive: true })
  const script = join(bin, "bun")
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      `echo "$*" >> "${log}"`,
      // Every call records the directory it ran in, so a check or install that leaves the plugin root shows up.
      `printf '%s\\t%s\\n' "$1" "$(pwd)" >> "${log}.cwd"`,
      `case "$1" in -e) exit ${probeExit} ;; install) echo "install failed: registry down" >&2; exit ${installExit} ;; esac`,
      "exit 0",
      "",
    ].join("\n"),
  )
  chmodSync(script, 0o755)
  return bin
}

/** Each fake-bun call as its first argument and the directory it ran in, in call order. */
function callDirectories(): string[][] {
  return readFileSync(`${log}.cwd`, "utf8")
    .trim()
    .split("\n")
    .map((line) => {
      const [arg = "", cwd = ""] = line.split("\t")
      return [arg, realpathSync(cwd)]
    })
}

function launch(bin: string) {
  return spawnSync("bash", [LAUNCH], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, PATH: `${bin}:${process.env.PATH ?? ""}` },
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tribe-launch-"))
  log = join(dir, "bun.log")
  writeFileSync(log, "")
})

afterEach(() => {
  safeRemoveSync(dir, { within: tmpdir() })
})

describe("plugin launch", () => {
  test("a checkout whose imports resolve starts the server without installing into it", () => {
    const result = launch(fakeBun(0, 0))
    expect(result.status, result.stderr).toBe(0)
    const calls = readFileSync(log, "utf8").trim().split("\n")
    expect(calls.some((call) => call.startsWith("install"))).toBe(false)
    expect(calls.at(-1)).toBe(join(PLUGIN_ROOT, "server.ts"))
  })

  test("a checkout whose imports do not resolve installs, says so, then starts", () => {
    const result = launch(fakeBun(1, 0))
    expect(result.status, result.stderr).toBe(0)
    expect(result.stderr).toContain("dependencies do not resolve")
    const calls = readFileSync(log, "utf8").trim().split("\n")
    expect(calls.map((call) => call.split(" ")[0])).toEqual(["-e", "install", join(PLUGIN_ROOT, "server.ts")])
  })

  /** @failure launch.sh changed into the plugin root before exec, so every seat's adapter registered the plugin root as its project. */
  test("the server starts in the caller's directory, not the plugin root", () => {
    const result = launch(fakeBun(1, 0))
    expect(result.status, result.stderr).toBe(0)
    expect(callDirectories().at(-1)).toEqual([join(PLUGIN_ROOT, "server.ts"), realpathSync(dir)])
  })

  /**
   * @failure The resolve check ran in the caller's directory: from a host checkout it exits 1, so every launch there
   * reinstalled into the plugin tree under running processes (25513, review2's launch-cwd verdict).
   */
  test("the resolve check and the install run in the plugin root", () => {
    const result = launch(fakeBun(1, 0))
    expect(result.status, result.stderr).toBe(0)
    const root = realpathSync(PLUGIN_ROOT)
    expect(callDirectories().slice(0, 2)).toEqual([
      ["-e", root],
      ["install", root],
    ])
  })

  test("a failed install stops the start and keeps its stderr", () => {
    const result = launch(fakeBun(1, 3))
    expect(result.status).toBe(3)
    expect(result.stderr).toContain("install failed: registry down")
    expect(readFileSync(log, "utf8")).not.toContain("server.ts")
  })

  test("both declared start paths run this one launcher", () => {
    const mcp = JSON.parse(readFileSync(join(PLUGIN_ROOT, ".mcp.json"), "utf8")) as {
      mcpServers: { tribe: { command: string; args: string[] } }
    }
    expect(mcp.mcpServers.tribe).toEqual({ command: "bash", args: ["${CLAUDE_PLUGIN_ROOT}/launch.sh"] })
    const pkg = JSON.parse(readFileSync(join(PLUGIN_ROOT, "package.json"), "utf8")) as { scripts: { start: string } }
    expect(pkg.scripts.start).toBe("bash launch.sh")
  })
})
