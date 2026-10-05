/**
 * @failure A consumer import regains the full wire graph or two subpaths claim one public name.
 * @level l2
 * @consumer 24965 tribe-wire subpath split
 * @reach fs-walk vendor/tribe/packages/wire/src/**
 * @testonly none
 *
 * The consumer subpaths are narrow doors onto the root barrel's names,
 * one home per name.
 * A name reachable through two subpaths would let consumers of one name split
 * across two graphs; a subpath exporting a name the root lacks would grow the
 * public surface through a side door.
 */
import { readFileSync, realpathSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const manifest = JSON.parse(readFileSync(join(PACKAGE, "package.json"), "utf8")) as { exports: Record<string, string> }
const SUBPATHS = [
  "./launch-environment",
  "./client",
  "./trust",
  "./records",
  "./service-send",
  "./lib/daemon-environment",
] as const
const entry = (subpath: string): string => {
  const target = manifest.exports[subpath]
  if (target === undefined) throw new Error(`package.json exports has no ${subpath}`)
  return resolve(PACKAGE, target)
}
const ROOT = entry(".")

async function names(file: string): Promise<Set<string>> {
  return new Set(Object.keys((await import(file)) as Record<string, unknown>))
}

const transpiler = new Bun.Transpiler({ loader: "ts" })
function closureOf(start: string): { files: Set<string>; cycles: string[] } {
  const files = new Set<string>()
  const active = new Set<string>()
  const cycles: string[] = []
  const visit = (path: string): void => {
    const file = realpathSync(path)
    if (active.has(file)) {
      cycles.push(file)
      return
    }
    if (files.has(file)) return
    files.add(file)
    active.add(file)
    for (const imported of transpiler.scan(readFileSync(file, "utf8")).imports) {
      if (imported.path.startsWith(".")) visit(resolve(dirname(file), imported.path))
    }
    active.delete(file)
  }
  visit(start)
  return { files, cycles }
}

describe("tribe-wire's consumer subpaths", () => {
  it("export pairwise disjoint name sets whose union is inside the root barrel", async () => {
    const root = await names(ROOT)
    const sets = await Promise.all(SUBPATHS.map(async (subpath) => [subpath, await names(entry(subpath))] as const))
    for (const [subpath, set] of sets) {
      expect(set.size, `${subpath} exports nothing`).toBeGreaterThan(0)
      expect(
        [...set].filter((name) => !root.has(name)),
        `${subpath} exports names the root barrel lacks`,
      ).toEqual([])
    }
    for (let i = 0; i < sets.length; i++) {
      for (let j = i + 1; j < sets.length; j++) {
        const [a, left] = sets[i]!
        const [b, right] = sets[j]!
        expect(
          [...left].filter((name) => right.has(name)),
          `${a} and ${b} both export`,
        ).toEqual([])
      }
    }
  })

  it("re-export leaf modules only: no subpath entry imports the root barrel or another subpath's entry", () => {
    const entries = new Set([ROOT, ...SUBPATHS.map(entry)])
    for (const subpath of SUBPATHS) {
      const file = entry(subpath)
      const specifiers = [...readFileSync(file, "utf8").matchAll(/\bfrom\s*["'](\.{1,2}\/[^"']+)["']/gu)].map(
        (m) => m[1]!,
      )
      const bad = specifiers.filter((specifier) => entries.has(resolve(dirname(file), specifier)))
      expect(bad, `${subpath} (${file}) imports another entry`).toEqual([])
    }
  })

  it("keeps the measured subpath closures narrow and the direction free of cycles", () => {
    const root = closureOf(ROOT)
    const client = closureOf(entry("./client"))
    const records = closureOf(entry("./records"))
    const sender = closureOf(entry("./service-send"))
    const daemonEnvironment = closureOf(entry("./lib/daemon-environment"))
    for (const graph of [root, client, records, sender, daemonEnvironment]) expect(graph.cycles).toEqual([])
    expect(root.files.size).toBeGreaterThan(sender.files.size)
    // 26564 adds the shared own-transport ACK validator to launch certification.
    // Its delivery leaf is the sole additional file; the broad graph stays excluded.
    expect(client.files.has(realpathSync(resolve(PACKAGE, "src/lib/delivery.ts")))).toBe(true)
    // 27089 adds one stall-time /proc sample on the generic 10 s CLI deadline.
    // Its stall-sample leaf is the sole additional file; the broad graph stays excluded.
    expect(client.files.has(realpathSync(resolve(PACKAGE, "src/stall-sample.ts")))).toBe(true)
    // 27314 B1 adds the credential-file leaf behind identity-token, which the client graph already
    // carries. It is the sole additional file; the broad graph stays excluded.
    expect(client.files.has(realpathSync(resolve(PACKAGE, "src/lib/credential-file.ts")))).toBe(true)
    expect(client.files.size).toBeLessThanOrEqual(19)
    expect(records.files.size).toBeLessThanOrEqual(10)
    expect(sender.files.has(realpathSync(resolve(PACKAGE, "src/lib/delivery.ts")))).toBe(true)
    // stall-sample.ts rides the client graph into the sender subpath.
    expect(sender.files.has(realpathSync(resolve(PACKAGE, "src/stall-sample.ts")))).toBe(true)
    // 27314 B1's credential-file leaf rides the client graph into the sender subpath too.
    expect(sender.files.has(realpathSync(resolve(PACKAGE, "src/lib/credential-file.ts")))).toBe(true)
    expect(sender.files.size).toBeLessThanOrEqual(21)
    expect(records.files.has(realpathSync(resolve(PACKAGE, "src/client.ts")))).toBe(false)
    for (const exclusive of ["src/service-send.ts", "src/launch-seat.ts", "src/cli/mcp-json-content.ts"]) {
      expect(client.files.has(realpathSync(resolve(PACKAGE, exclusive))), exclusive).toBe(false)
    }
    expect(daemonEnvironment.files.has(realpathSync(resolve(PACKAGE, "src/daemon-environment.ts")))).toBe(true)
  })
})
