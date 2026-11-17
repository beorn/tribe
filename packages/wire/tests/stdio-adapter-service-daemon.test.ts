/**
 * @failure  a Hab service actor (e.g. the 30968 grok-30968 Echo) registers through the stdio adapter as an
 *           ordinary agent — or not at all — so it can never own its inbox ball, and a hosted MCP participant
 *           silently degrades to an uncertified name on the daemon.
 * @level    l1
 * @consumer @i/6-dev/30968 (@cto delta GO: repair the existing stdio adapter's service registration)
 * @testonly none
 *
 * Real daemon + real stdio adapters: a service-token adapter must register as a certified service principal
 * (principal_class service, keyed under its own pid, pull delivery), consume its own inbox, settle its own
 * tracked ball with tracker.closed > 0, and retain that ownership across a same-launch reconnect. Another
 * principal must not settle its ball, and once its lifetime closes the name reads disconnected.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { safeRemoveSync } from "removely"
import { afterEach, describe, expect, it } from "vitest"
import { openDatabase } from "../../daemon/src/lib/database.ts"
import { tribeAmbientEnvironmentNames } from "../src/daemon-environment.ts"
import { launchToken } from "./launch-token.ts"

const HERE = dirname(fileURLToPath(import.meta.url))
const ADAPTER = resolve(HERE, "../src/stdio-adapter.ts")
const DAEMON = resolve(HERE, "../../daemon/src/daemon.ts")
const BUN_BIN = process.versions.bun ? process.execPath : "bun"

const SERVICE = "grok-30968"
const REQUESTER = "@requester"

const BASE_ENV: NodeJS.ProcessEnv = (() => {
  const env = { ...process.env }
  for (const name of tribeAmbientEnvironmentNames()) delete env[name]
  return env
})()

type AdapterHandle = {
  child: ChildProcessWithoutNullStreams
  stdout: Record<string, unknown>[]
  logPath: string
}

const children: ChildProcessWithoutNullStreams[] = []
let tmpDir = ""

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL")
  if (tmpDir) safeRemoveSync(tmpDir, { within: realpathSync(tmpdir()), allowMissing: true })
  tmpDir = ""
})

function writeJson(child: ChildProcessWithoutNullStreams, payload: Record<string, unknown>): void {
  child.stdin.write(`${JSON.stringify(payload)}\n`)
}

function collectStdout(child: ChildProcessWithoutNullStreams): Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = []
  let buffer = ""
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8")
    for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      if (line.trim()) lines.push(JSON.parse(line) as Record<string, unknown>)
    }
  })
  return lines
}

async function waitFor(condition: () => boolean, label: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`timed out waiting for ${label}`)
}

function toolResult(adapter: AdapterHandle, id: number): Record<string, unknown> {
  const response = adapter.stdout.find((line) => line.id === id)
  const result = response?.result as { content?: Array<{ text?: string }> } | undefined
  const text = result?.content?.[0]?.text
  if (typeof text !== "string") throw new Error(`no tool result for id ${id}: ${JSON.stringify(response)}`)
  return JSON.parse(text) as Record<string, unknown>
}

async function callTool(
  adapter: AdapterHandle,
  id: number,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  writeJson(adapter.child, {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  })
  try {
    await waitFor(() => adapter.stdout.some((line) => line.id === id), `${name} response`)
  } catch (error) {
    const log = existsSync(adapter.logPath) ? readFileSync(adapter.logPath, "utf8").slice(-2000) : "(no log)"
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${log}`)
  }
  return toolResult(adapter, id)
}

/** Registration can lag the initialize handshake; retry a members call until the daemon knows this adapter. */
async function callToolWhenRegistered(
  adapter: AdapterHandle,
  firstId: number,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 30_000
  let id = firstId
  for (;;) {
    const result = await callTool(adapter, id, name, args)
    const text = JSON.stringify(result)
    if (!text.includes("awaiting daemon registration") && !text.includes("daemon connection closed")) return result
    if (Date.now() > deadline) throw new Error(`adapter never registered: ${text}`)
    id += 100
    await new Promise((r) => setTimeout(r, 100))
  }
}

function spawnAdapter(name: string, idToken: string, logName: string): AdapterHandle {
  const logPath = join(tmpDir, logName)
  const child = spawn(BUN_BIN, [ADAPTER, "--socket", join(tmpDir, "tribe.sock"), "--name", name], {
    cwd: tmpDir,
    env: {
      ...BASE_ENV,
      TRIBE_NAME: "",
      TRIBE_SESSION_NAME: "",
      TRIBE_DELIVERY: "pull",
      TRIBE_PULL_TRANSPORT: "mcp",
      TRIBE_NO_AUTOSTART: "1",
      TRIBE_REQUIRE_JOIN: "0",
      TRIBE_TAKEOVER: "1",
      TRIBE_PLUGIN_ADAPTER_CHILD: "",
      TRIBE_PLUGIN_PROVIDER_PARENT_PID: "1",
      HAB_ID_TOKEN: idToken,
      DEBUG: "tribe:*",
      DEBUG_LOG: logPath,
    },
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams
  children.push(child)
  const adapter: AdapterHandle = { child, stdout: collectStdout(child), logPath }
  writeJson(child, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "tribe-service-daemon-test", version: "0" },
    },
  })
  writeJson(child, { jsonrpc: "2.0", method: "notifications/initialized", params: {} })
  return adapter
}

function sessionRow(dbPath: string, name: string): Record<string, unknown> | null {
  const db = openDatabase(dbPath)
  try {
    return (
      (db
        .prepare("SELECT name, principal_class, launch_id, launch_parent_pid, delivery FROM sessions WHERE name = ?")
        .get(name) as Record<string, unknown> | null) ?? null
    )
  } finally {
    db.close()
  }
}

describe("stdio adapter service registration against the real daemon (30968)", () => {
  it("certified service owner: registers, consumes its inbox, settles only its own ball, survives reconnect", async () => {
    tmpDir = mkdtempSync(join(realpathSync(tmpdir()), "tribe-svc-daemon-"))
    const socketPath = join(tmpDir, "tribe.sock")
    const dbPath = join(tmpDir, "tribe.db")
    const verifierPath = join(tmpDir, "verifier.ts")
    writeFileSync(
      verifierPath,
      `export const IDENTITY_VERIFIER_INTERFACE = 1
export async function verifyIdentity(token) {
  const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"))
  const kind = claims.act && claims.act.kind === "service" ? { kind: "service" } : {}
  return { result: "verified", actor: claims.act.sub, sid: claims.sid, gen: claims.gen, ...kind }
}
`,
    )
    const daemon = spawn(
      BUN_BIN,
      [
        DAEMON,
        "--socket",
        socketPath,
        "--db",
        dbPath,
        "--foreground",
        "--no-lore",
        "--identity-verifier",
        verifierPath,
      ],
      {
        cwd: tmpDir,
        env: {
          ...BASE_ENV,
          TRIBE_NO_PLUGINS: "1",
          TRIBE_ACTIVITY_LOG: join(tmpDir, "activity.jsonl"),
          TRIBE_DAEMON_STDERR_LOG: join(tmpDir, "daemon-stderr.log"),
          DEBUG: "tribe:*",
          DEBUG_LOG: join(tmpDir, "daemon.log"),
          LOG_FILE: join(tmpDir, "daemon.log"),
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    ) as ChildProcessWithoutNullStreams
    children.push(daemon)
    await waitFor(() => existsSync(socketPath), "daemon socket")

    const serviceToken = launchToken("svc-launch-1", SERVICE, "service")
    const service = spawnAdapter(SERVICE, serviceToken, "service.log")
    await waitFor(() => sessionRow(dbPath, SERVICE) !== null, "service session row")
    const row = sessionRow(dbPath, SERVICE)!
    expect(row.principal_class).toBe("service")
    expect(row.launch_parent_pid).toBe(service.child.pid)
    expect(row.delivery).toBe("pull")

    const requester = spawnAdapter(REQUESTER, launchToken("req-launch-1", REQUESTER), "requester.log")
    await callToolWhenRegistered(requester, 10, "members", {})

    const opened = await callToolWhenRegistered(requester, 20, "send", {
      to: SERVICE,
      message: "echo roundtrip please",
      type: "request",
      summary: "echo roundtrip please",
      request: "svc-req-1",
    })
    expect(opened.sent).toBe(true)

    // A different principal cannot settle the service's ball.
    const foreign = await callToolWhenRegistered(requester, 30, "send", {
      to: SERVICE,
      message: "settling someone else's ball",
      type: "response",
      summary: "settling someone else's ball",
      reply: "svc-req-1",
    })
    expect((foreign.tracker as { closed?: number } | undefined)?.closed ?? 0).toBe(0)

    // The service consumes its own inbox and sees the open ball.
    const fetched = await callToolWhenRegistered(service, 40, "fetch", {})
    expect(JSON.stringify(fetched)).toContain("echo roundtrip please")

    // The service's exact reply settles its own ball.
    const settled = await callToolWhenRegistered(service, 50, "send", {
      to: REQUESTER,
      message: "echo: roundtrip",
      type: "response",
      summary: "echo: roundtrip",
      reply: "svc-req-1",
    })
    expect((settled.tracker as { closed?: number } | undefined)?.closed ?? 0).toBeGreaterThan(0)

    // Same-launch reconnect retains service ownership under the new pid.
    service.child.kill("SIGKILL")
    await new Promise((r) => setTimeout(r, 200))
    const reconnected = spawnAdapter(SERVICE, serviceToken, "service-reconnect.log")
    await waitFor(
      () => sessionRow(dbPath, SERVICE)?.launch_parent_pid === reconnected.child.pid,
      "reconnected service session row",
    )
    expect(sessionRow(dbPath, SERVICE)?.principal_class).toBe("service")

    const reopened = await callToolWhenRegistered(requester, 60, "send", {
      to: SERVICE,
      message: "second roundtrip",
      type: "request",
      summary: "second roundtrip",
      request: "svc-req-2",
    })
    expect(reopened.sent).toBe(true)
    const settledAgain = await callToolWhenRegistered(reconnected, 70, "send", {
      to: REQUESTER,
      message: "echo: second",
      type: "response",
      summary: "echo: second",
      reply: "svc-req-2",
    })
    expect((settledAgain.tracker as { closed?: number } | undefined)?.closed ?? 0).toBeGreaterThan(0)

    // Closed lifetime loses authority: after the service dies, its name is no
    // longer a live transport the requester can reach as connected.
    reconnected.child.kill("SIGKILL")
    let lastState: string | undefined = "connected"
    const disconnectDeadline = Date.now() + 20_000
    let memberId = 80
    while (Date.now() < disconnectDeadline && lastState === "connected") {
      const members = await callToolWhenRegistered(requester, memberId, "members", {})
      memberId += 100
      const sessions = (members.sessions ?? []) as Array<{ name: string; transport_state: string }>
      lastState = sessions.find((s) => s.name === SERVICE)?.transport_state
      if (lastState === "connected") await new Promise((r) => setTimeout(r, 100))
    }
    expect(lastState).not.toBe("connected")
  }, 60_000)
})
