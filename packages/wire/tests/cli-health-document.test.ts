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
 * Full diagnostic JSON instead emits the existing MCP body on exit 0; failures keep the /2 document.
 * @consumer hab service probes and CLI diagnostic-capture readers
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

let diagnosticCase = 0
async function runHealthReply(
  args: readonly string[],
  reply: { result?: unknown; error?: { code: string; message: string } },
) {
  const socketPath = join(DIR, `reply-${diagnosticCase++}.sock`)
  const methods: string[] = []
  const server = createServer((socket) => {
    let buffer = ""
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8")
      const newline = buffer.indexOf("\n")
      if (newline < 0) return
      const request = JSON.parse(buffer.slice(0, newline)) as { id: number; method: string }
      buffer = buffer.slice(newline + 1)
      methods.push(request.method)
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, ...reply })}\n`)
    })
  })
  await new Promise<void>((ready) => server.listen(socketPath, ready))
  try {
    const child = spawn(BUN_BIN, [CLI, "health", ...args], {
      env: probeEnv(socketPath),
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk
    })
    const code = await new Promise<number | null>((settle, reject) => {
      child.on("close", settle)
      child.on("error", reject)
    })
    return { stdout, stderr, code, methods, socketPath }
  } finally {
    server.close()
  }
}

describe("health service-probe and full diagnostic capture contracts", () => {
  // Hab only needs control-path liveness. A full cli_health diagnostic here
  // read 849 MB per probe on the live store (29521).
  it.each([
    ["healthy", undefined],
    ["absent", "ENOENT"],
    ["unhealthy", "diagnostic-failed"],
    ["unknown", "TRIBE_DAEMON_CALL_TIMEOUT"],
  ] as const)("uses lightweight status for the %s arm", async (state, errorCode) => {
    const { stdout, code, methods } = await runHealthReply(
      ["--json"],
      errorCode
        ? { error: { code: errorCode, message: "probe condition" } }
        : { result: { daemon: { pid: 42, uptime: 100, clients: 2 }, sessions: [{ name: "a" }] } },
    )
    expectOneDocument(stdout, code)
    const document = JSON.parse(stdout) as { state: string; facts?: Record<string, unknown> }
    expect(document.state).toBe(state)
    expect(methods).toEqual(["cli_status"])
    if (state === "healthy") {
      expect(document.facts).toEqual({ pid: 42, uptime: 100, clients: 2, sessions: 1 })
    }
  })

  // The existing liveness cases cannot detect a dropped diagnostic body or a raw malformed dump.
  it.each([
    ["default human", []],
    ["explicit full human", ["--full"]],
    ["full JSON", ["--full", "--json"]],
  ] as const)("renders %s diagnostics", async (_name, flags) => {
    for (const inbox_lag of [[{ session: "@chief", actionable_rows: 2 }], []]) {
      const body = { cadence: { inbox_lag }, issues: [], retained: { exact: "λ" } }
      const response = await runHealthReply(flags, {
        result: { content: [{ type: "text", text: JSON.stringify(body) }], machine: { wrapperOnly: true } },
      })
      expect(response.code).toBe(0)
      expect(response.methods).toEqual(["cli_health"])
      if ((flags as readonly string[]).includes("--json")) {
        expect(response.stdout).toBe(`${JSON.stringify(body, null, 2)}\n`)
      } else {
        expect(response.stdout).toContain("TRIBE HEALTH DIAGNOSTICS")
        expect(response.stdout).toContain("No issues detected.")
      }
      expect(response.stderr).toBe("")
    }
  })

  it.each([
    ["missing cadence", JSON.stringify({ issues: [] }), "cadence"],
    ["missing inbox lag", JSON.stringify({ cadence: {} }), "cadence.inbox_lag"],
    ["non-JSON content", "not JSON", "cadence"],
  ])("refuses %s in a full capture", async (_name, text, missing) => {
    const response = await runHealthReply(["--full", "--json"], { result: { content: [{ type: "text", text }] } })
    expectOneDocument(response.stdout, response.code)
    expect(response.code).toBe(2)
    expect((JSON.parse(response.stdout) as { error: { cause: string } }).error.cause).toContain(missing)
    expect(response.stderr).toContain("cli_health")
    expect(response.stderr).toContain(response.socketPath)
    expect(response.methods).toEqual(["cli_health"])
  })

  it("retains unknown/3 for a full diagnostic timeout", async () => {
    const response = await runHealthReply(["--full", "--json"], {
      error: { code: "TRIBE_DAEMON_CALL_TIMEOUT", message: "diagnostic deadline" },
    })
    expectOneDocument(response.stdout, response.code)
    expect(response.code).toBe(3)
    expect((JSON.parse(response.stdout) as { verdict: { reason: string } }).verdict.reason).toBe("timeout")
    expect(response.stderr).toContain("cli_health")
  })

  it("retains absent/1 for a full capture without a daemon", () => {
    const response = spawnSync(BUN_BIN, [CLI, "health", "--full", "--json"], {
      encoding: "utf8",
      timeout: 30_000,
      env: probeEnv(join(DIR, "full-absent.sock")),
    })
    expectOneDocument(response.stdout, response.status)
    expect(response.status).toBe(1)
    expect((JSON.parse(response.stdout) as { state: string }).state).toBe("absent")
    expect(response.stderr).toContain("cli_health")
  }, 30_000) // A full capture deliberately retains the client's six-second restart-retry window.

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
