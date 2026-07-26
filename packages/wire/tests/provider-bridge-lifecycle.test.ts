/**
 * @failure A provider-owned MCP bridge can create a detached Tribe daemon
 *          when the declared singleton is absent, escaping its lifecycle owner.
 * @level   l0
 * @consumer @ag/tribe/22322-daemon-restart-drops-bridges-with-no-repair-verb
 */

import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const sourceDir = resolve(dirname(fileURLToPath(import.meta.url)), "../src")
const stdioSource = readFileSync(resolve(sourceDir, "stdio-adapter.ts"), "utf8")
const httpSource = readFileSync(resolve(sourceDir, "http-adapter.ts"), "utf8")

describe("provider bridge lifecycle ownership", () => {
  it("keeps the stdio bridge connect-only", () => {
    const start = stdioSource.indexOf("function startDaemonConnection")
    const end = stdioSource.indexOf("\n}\n", start)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(stdioSource.slice(start, end)).toMatch(/noSpawn:\s*true/u)
  })

  it("keeps the HTTP bridge connect-only", () => {
    const start = httpSource.indexOf("export async function startTribeHttpMcpServer")
    const end = httpSource.indexOf("\n  const http =", start)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(httpSource.slice(start, end)).toMatch(/noSpawn:\s*true/u)
  })
})
