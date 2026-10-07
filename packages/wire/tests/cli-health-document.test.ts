/**
 * `tribe health --json` owes its reader exactly one hab-service-health/2 document on every exit path.
 *
 * The declared probe (vendor/tribe/hab.projects.ts) runs this command. When it produces no parseable
 * document, the reader cannot tell "the probe said nothing" from "the probe never ran": hab pages
 * `health could not be determined (absent): the probe answered, and nothing it said established whether
 * the service is running`. Bead 27871 has that page twice on 2026-10-06, with the daemon healthy both times.
 *
 * @failure  the declared wire health probe exits 0 with empty or unparseable stdout
 * @level    l2 - a real Bun child runs the declared command against a socket absent, refusing, or dying mid-call
 * @consumer hab (hab.projects.ts declares `health: { command: "tribe health --json" }`)
 * @testonly none
 */

import { spawn, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../src/cli.ts")
const BUN_BIN = process.env.BUN_EXECUTABLE ?? "bun"

/** The `/2` contract's own state/exit table (hab-core): any other pairing is refused as a broken contract. */
const EXIT_FOR_STATE: Record<string, number> = { healthy: 0, absent: 1, unhealthy: 2, unknown: 3 }

/** Prove `stdout` is ONE document — parseable, contract-conformant, and nothing logged beside it. */
function expectOneDocument(stdout: string, exitCode: number | null): void {
  expect(stdout.trim(), "stdout must carry a document, never nothing").not.toBe("")
  const document = JSON.parse(stdout) as { schema?: unknown; service?: unknown; state?: unknown }
  expect(document.schema).toBe("hab-service-health/2")
  expect(document.service).toBe("wire")
  expect(Object.keys(EXIT_FOR_STATE)).toContain(document.state)
  expect(exitCode).toBe(EXIT_FOR_STATE[document.state as string])
  // Byte for byte: any stray line before or after the document is exactly the corruption this guards.
  expect(stdout).toBe(`${JSON.stringify(document, null, 2)}\n`)
}

function probeEnv(socketPath: string): NodeJS.ProcessEnv {
  return { ...process.env, TRIBE_SOCKET: socketPath, TRIBE_NO_AUTOSTART: "1" }
}

const DIR = mkdtempSync(join(tmpdir(), "tribe-health-document-"))
const REGULAR_FILE = join(DIR, "regular-file.sock")
writeFileSync(REGULAR_FILE, "not a socket\n")
const AS_DIRECTORY = join(DIR, "as-directory")
mkdirSync(AS_DIRECTORY)

afterAll(() => {
  rmSync(DIR, { recursive: true, force: true })
})

describe("tribe health --json emits exactly one document on every exit path", () => {
  it.each([
    ["a missing socket", join(DIR, "missing.sock")],
    ["a regular file where a socket belongs", REGULAR_FILE],
    ["a directory where a socket belongs", AS_DIRECTORY],
    ["a path under a missing parent", join(DIR, "nope", "tribe.sock")],
  ])("writes one contract-conformant document for %s", (_label, socketPath) => {
    const result = spawnSync(BUN_BIN, [CLI, "health", "--json"], {
      encoding: "utf8",
      timeout: 30_000,
      env: probeEnv(socketPath),
    })
    expectOneDocument(result.stdout ?? "", result.status)
  })

  it("writes one contract-conformant document when the socket dies mid-call", async () => {
    const socketPath = join(DIR, "dies.sock")
    const server = createServer((socket) => socket.destroy())
    await new Promise<void>((ready) => server.listen(socketPath, ready))
    try {
      const child = spawn(BUN_BIN, [CLI, "health", "--json"], {
        env: probeEnv(socketPath),
        stdio: ["ignore", "pipe", "pipe"],
      })
      let stdout = ""
      child.stdout.setEncoding("utf8")
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk
      })
      const code = await new Promise<number | null>((settle) => {
        child.on("close", (exitCode) => settle(exitCode))
      })
      expectOneDocument(stdout, code)
    } finally {
      server.close()
    }
  })
})
