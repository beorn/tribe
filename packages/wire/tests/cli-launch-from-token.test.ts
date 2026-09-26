/**
 * @failure A process without a hab identity token, holding only a seat's inherited TRIBE_LAUNCH_ID and TRIBE_NAME
 *          (a tokenless child of the controller, measured 2026-09-25), resolves and drains that seat's inbox.
 * @level l2
 * @consumer `tribe inbox-status|inbox-wait|inbox-drain` without --session: the /do authentication step, tent await,
 *           the session hooks (25074 3d-1); `tribe send`'s caller lookup, for a malformed token
 * @testonly none
 *
 * The CLI's managed inbox request takes its launch id from the identity token's sid, never from TRIBE_LAUNCH_ID
 * (25074 3d-1, @cto 2bfc1935; the refusal row is @cto 58dfc750's witness). For a hab seat the two held the same value,
 * so a seat reads exactly the inbox it read before; after 3d-2 no launcher sets TRIBE_LAUNCH_ID at all. A tokenless
 * process is refused by name before any call reaches the daemon, and a malformed token fails locally, by name.
 */

import { spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer, type Server } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { tribeAmbientEnvironmentNames } from "../src/daemon-environment.ts"
import { TRIBE_PROTOCOL_VERSION } from "../src/lib/socket.ts"
import { launchToken } from "./launch-token.ts"

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../src/cli.ts")
const BUN_BIN = process.env.BUN_EXECUTABLE ?? "bun"
const SEAT = "@dev/2"
const TOKEN_SID = "7b1c0d2e-token-sid"
const INHERITED_LAUNCH = "37920dbf-another-seats-launch"

let dir: string
let server: Server
let calls: Array<{ method: string; params?: Record<string, unknown> }>

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "tribe-cli-launch-from-token-"))
  calls = []
  server = createServer((socket) => {
    let buffer = ""
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8")
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (!line.trim()) continue
        const request = JSON.parse(line) as { id: number; method: string; params?: Record<string, unknown> }
        calls.push({ method: request.method, params: request.params })
        const result =
          request.method === "cli_protocol"
            ? { protocol_version: TRIBE_PROTOCOL_VERSION }
            : { session: SEAT, unread_count: 0, oldest_unread_age_min: 0, oldest_unread_ts: 0 }
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`)
      }
    })
  })
  await new Promise<void>((listening) => server.listen(join(dir, "tribe.sock"), listening))
})
afterEach(async () => {
  await new Promise<void>((closed) => server.close(() => closed()))
  rmSync(dir, { recursive: true, force: true })
})

/** The CLI in a child whose identity is exactly `identity`: this test session's own token and names never leak in. */
function runCli(args: string[], identity: Record<string, string>): Promise<{ code: number | null; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const name of tribeAmbientEnvironmentNames()) delete env[name]
  Object.assign(env, { TRIBE_SOCKET: join(dir, "tribe.sock"), TRIBE_NO_AUTOSTART: "1" }, identity)
  return new Promise((done) => {
    const child = spawn(BUN_BIN, [CLI, ...args], { env, stdio: ["ignore", "ignore", "pipe"], timeout: 15_000 })
    let stderr = ""
    child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")))
    child.on("close", (code) => done({ code, stderr }))
  })
}

const byLaunchCalls = () => calls.filter((call) => call.method.endsWith("_by_launch_v1"))

describe("the CLI's managed inbox reads its launch from the identity token (25074 3d-1)", () => {
  it("a seat's inbox-status names the token's sid, not an inherited TRIBE_LAUNCH_ID beside it", async () => {
    const run = await runCli(["inbox-status", "--json"], {
      HAB_ID_TOKEN: launchToken(TOKEN_SID, SEAT),
      TRIBE_LAUNCH_ID: INHERITED_LAUNCH,
      TRIBE_NAME: SEAT,
    })
    expect(run, run.stderr).toMatchObject({ code: 0 })
    expect(byLaunchCalls()).toEqual([
      { method: "cli_inbox_status_by_launch_v1", params: { launch_id: TOKEN_SID, persona: SEAT } },
    ])
  })

  it("a tokenless process holding a seat's TRIBE_LAUNCH_ID and TRIBE_NAME is refused, and reaches no inbox", async () => {
    const inherited = { TRIBE_LAUNCH_ID: INHERITED_LAUNCH, TRIBE_NAME: "@chief", TRIBE_SESSION_NAME: "@chief" }
    for (const verb of [
      ["inbox-status", "--json"],
      ["inbox-drain", "--json"],
    ]) {
      const run = await runCli(verb, inherited)
      expect(run.code, `${verb[0]}: ${run.stderr}`).not.toBe(0)
      // One line naming the verb and the cure, never an uncaught exception's source excerpt and stack.
      expect(run.stderr.trim().split("\n")).toEqual([
        expect.stringMatching(new RegExp(`^tribe ${verb[0]}: .*HAB_ID_TOKEN`)),
      ])
    }
    expect(byLaunchCalls()).toEqual([])
  })

  it("a malformed token fails locally, by name, before the daemon is asked", async () => {
    const run = await runCli(["inbox-status", "--json"], { HAB_ID_TOKEN: "not-a-jwt", TRIBE_NAME: SEAT })
    expect(run.code).not.toBe(0)
    expect(run.stderr.trim().split("\n")).toEqual([
      expect.stringMatching(/^tribe inbox-status: HAB_ID_TOKEN is malformed: .*relaunch the seat through hab$/),
    ])
    expect(byLaunchCalls()).toEqual([])
  })

  it("send, given a malformed token, refuses in one line and sends nothing (review of 4c7f239adf, note 1)", async () => {
    const run = await runCli(["send", "@chief", "hello", "--summary", "hello"], {
      HAB_ID_TOKEN: "not-a-jwt",
      TRIBE_NAME: SEAT,
    })
    expect(run.code).toBe(1)
    expect(run.stderr.trim().split("\n")).toEqual([
      expect.stringMatching(/^tribe\.send: delivery refused - HAB_ID_TOKEN is malformed: .*; not sending\.$/),
    ])
    expect(calls.filter((call) => call.method !== "cli_protocol")).toEqual([])
  })
})
