/**
 * @failure `lib/config` built `@bearly/flock` and `removely` into the startup of both
 *          halves of every tribe bridge — the supervisor, which locks nothing, and the
 *          adapter child, which never probes `.beads/` — so each launch paid ~2.8 MB +
 *          ~2.1 MB it never used.
 * @level l0
 * @consumer tribe bridge startup (the supervisor and the adapter child)
 *
 * 27941. The unit under test is the module GRAPH, not a call: the cost is paid at import,
 * so the honest assertion is that no path from either half's entry file reaches flock, and
 * the measured RSS difference a fresh process sees. Measured on one host 2026-10-07
 * (median of 5 fresh `bun --eval`, GC'd): flock +2.75 MB, removely +2.14 MB, both +4.45 MB
 * on top of `config`'s own closure. The predecessor estimate (+7 MB each) double-counted a
 * shared closure and was ~2.6x too large.
 *
 * The real halves move less, because the bridge already carries most of that shared closure:
 * the supervisor drops both dependencies (−2.1 MB median of 5 real supervisor processes, 36.2
 * -> 34.1) and the adapter child drops flock only (−0.9 MB, 67.3 -> 66.5). The RSS assertions
 * below measure the isolated import in a bare process — a stable proxy, deliberately not the
 * headline number.
 * @testonly none
 */

import { existsSync, readFileSync, statSync } from "node:fs"
import { dirname, resolve as resolvePath } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { describe, expect, test } from "vitest"

const here = dirname(fileURLToPath(import.meta.url))
const wireRoot = resolvePath(here, "..")
const wireSrc = resolvePath(wireRoot, "src")
const tribeRoot = resolvePath(wireRoot, "..", "..")

const HEAVY = ["@bearly/flock", "removely"] as const

/** Bare and relative specifiers an ESM file pulls in — static, re-export, dynamic, require. */
function specifiersIn(file: string): { bare: string[]; relative: string[] } {
  const text = readFileSync(file, "utf8")
  const bare: string[] = []
  const relative: string[] = []
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/gu,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/gu,
  ]
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const specifier = match[1]
      if (specifier === undefined) continue
      if (specifier.startsWith(".")) relative.push(specifier)
      else bare.push(specifier)
    }
  }
  return { bare, relative }
}

/** A specifier's file on disk, or null for a package/builtin we do not walk into. */
function resolveNode(specifier: string, fromFile: string): string | null {
  if (specifier.startsWith("tribe-wire/")) {
    const sub = specifier.slice("tribe-wire/".length)
    const candidate = resolvePath(wireSrc, sub.endsWith(".ts") ? sub : `${sub}.ts`)
    return existsSync(candidate) ? candidate : null
  }
  if (!specifier.startsWith(".")) return null
  const base = resolvePath(dirname(fromFile), specifier)
  for (const candidate of [base, `${base}.ts`, resolvePath(base, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  throw new Error(`${fromFile} imports ${specifier}, which resolves to no file`)
}

/** Every module reachable from `entries`, plus the bare packages that graph imports. */
function moduleGraph(entries: string[]): { files: Set<string>; bare: Set<string> } {
  const files = new Set<string>()
  const bare = new Set<string>()
  const queue = [...entries]
  while (queue.length > 0) {
    const file = queue.pop() as string
    if (files.has(file)) continue
    files.add(file)
    const found = specifiersIn(file)
    for (const specifier of found.bare) bare.add(specifier)
    for (const specifier of found.relative) {
      const node = resolveNode(specifier, file)
      if (node !== null) queue.push(node)
    }
  }
  return { files, bare }
}

describe("tribe bridge startup does not build the heavy config deps (27941)", () => {
  test("neither the supervisor nor the adapter child reaches @bearly/flock", () => {
    const halves: Array<[string, string]> = [
      ["supervisor", resolvePath(tribeRoot, "plugins", "claude", "server.ts")],
      ["adapter child", resolvePath(wireSrc, "stdio-adapter.ts")],
    ]
    for (const [half, entry] of halves) {
      expect(existsSync(entry), `${half} entry ${entry} exists`).toBe(true)
      const graph = moduleGraph([entry])
      expect(
        [...graph.bare].filter((s) => s === "@bearly/flock"),
        `${half} must not import flock`,
      ).toEqual([])
      expect(
        [...graph.bare].filter((s) => s === "removely"),
        `${half} must not import removely`,
      ).toEqual(half === "adapter child" ? ["removely"] : [])
    }
  })

  test("config-light carries neither dependency, and the compat barrel still carries both", () => {
    const light = moduleGraph([resolvePath(wireSrc, "lib", "config-light.ts")])
    for (const specifier of HEAVY) {
      expect([...light.bare], `config-light must not import ${specifier}`).not.toContain(specifier)
    }
    // The barrel is the compatibility half: existing `tribe-wire/lib/config` importers keep
    // exactly today's behaviour, both dependencies included.
    const barrel = moduleGraph([resolvePath(wireSrc, "lib", "config.ts")])
    for (const specifier of HEAVY) {
      expect([...barrel.bare], `the barrel must keep re-exporting ${specifier}`).toContain(specifier)
    }
  })

  test("tribe-wire/lib/config still exposes the whole surface", async () => {
    const barrel = await import("tribe-wire/lib/config")
    for (const name of [
      "parseTribeArgs",
      "parseSessionDomains",
      "detectRole",
      "resolveProjectId",
      "resolveProjectName",
      "findBeadsDir",
      "resolveDbPath",
      "withDbPathLock",
      "migrateLegacyTribeDbIfNeeded",
    ]) {
      expect(typeof (barrel as Record<string, unknown>)[name], `${name} stays importable`).toBe("function")
    }
    const light = await import("tribe-wire/lib/config-light")
    expect(typeof light.parseTribeArgs).toBe("function")
  })

  test("a fresh import of the light modules is several MB smaller than the barrel", () => {
    const lib = resolvePath(wireSrc, "lib")
    const spawnRss = (files: string[]): number => {
      const source = files.map((f) => `await import(${JSON.stringify(pathToFileURL(f).href)})`).join(";")
      const samples: number[] = []
      for (let i = 0; i < 5; i++) {
        const proc = Bun.spawnSync(
          [
            process.execPath,
            "--eval",
            `${source};Bun.sleepSync(60);Bun.gc(true);console.log(process.memoryUsage.rss())`,
          ],
          {
            cwd: lib,
            stdout: "pipe",
            stderr: "pipe",
          },
        )
        if (proc.exitCode !== 0) {
          throw new Error(`bun --eval exited ${String(proc.exitCode)}: ${proc.stderr.toString()}`)
        }
        samples.push(Number(proc.stdout.toString().trim()))
      }
      const sorted = [...samples].sort((a, b) => a - b)
      const middle = sorted[Math.floor(sorted.length / 2)]
      if (middle === undefined) throw new Error("no RSS samples were collected")
      return middle
    }
    const MB = (bytes: number) => Math.round((bytes / 1048576) * 100) / 100
    const barrel = spawnRss([resolvePath(lib, "config.ts")])
    const supervisor = spawnRss([resolvePath(lib, "config-light.ts")])
    const adapter = spawnRss([resolvePath(lib, "config-light.ts"), resolvePath(lib, "beads-path.ts")])
    expect(
      barrel - supervisor,
      `supervisor import in a bare process: ${MB(barrel)} -> ${MB(supervisor)} MB`,
    ).toBeGreaterThan(2 * 1048576)
    expect(barrel - adapter, `adapter import in a bare process: ${MB(barrel)} -> ${MB(adapter)} MB`).toBeGreaterThan(
      1 * 1048576,
    )
  })
})
