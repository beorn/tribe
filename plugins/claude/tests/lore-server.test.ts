/**
 * @failure The provider-owned Claude recall bridge can autostart a detached
 *          Tribe daemon and escape the declared singleton's lifecycle owner.
 * @level   l0
 * @consumer @ag/tribe/22322-daemon-restart-drops-bridges-with-no-repair-verb
 *
 * Also pins the standalone marketplace install path and host boundary. The
 * pre-cutover placeholder pointed at bearly's @bearly/tribe; that era ended
 * with the 19273 move.
 */

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, test } from "vitest"

const RECALL_SERVER = readFileSync(resolve(import.meta.dirname, "../recall/server.ts"), "utf8")
const RECALL_SOCKET = readFileSync(resolve(import.meta.dirname, "../recall/lib/socket.ts"), "utf8")

describe("Claude plugin boundary", () => {
  test("keeps the provider-owned recall bridge connect-only", () => {
    expect(RECALL_SERVER).not.toContain("ensureTribeDaemonIfConfigured")
    expect(RECALL_SERVER).not.toContain("autostartChecked")
    expect(RECALL_SOCKET).toMatch(/noSpawn:\s*opts\.noSpawn/u)
  })

  test("documents the standalone marketplace install and Tribe boundary", () => {
    const readme = readFileSync(resolve(import.meta.dirname, "../README.md"), "utf8")

    expect(readme).toContain("/plugin marketplace add beorn/tribe")
    expect(readme).toContain("/plugin install tribe@tribe")
    expect(readme).toContain("Reusable protocol code belongs in `tribe-wire`")
    expect(readme).toContain("Project workflow conventions")
    expect(readme).not.toContain("Placeholder")
  })
})
