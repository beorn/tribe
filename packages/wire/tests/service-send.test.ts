/**
 * @failure  a hab job's page producer (`ag quota wall`, `hab attention`, `hab page project`) registers on a minted
 *           launch id with no identity token, so its session is never verified and 25074 3d cannot delete the
 *           minted-id path
 * @level    l1
 * @consumer @i/2-agent-launch/25074-hab-signs-one-identity-token-per-launch (3d prerequisite, @cto 27ac3aed)
 * @testonly none
 *
 * sendAs is the one register the three producers share. A process hab launched carries HAB_ID_TOKEN; its register
 * presents that token and the launch it names, never a minted id. A process with no token (a hand run) keeps a
 * minted id and says so, because that arm is the transition 3d deletes.
 */
import { mkdtempSync, realpathSync } from "node:fs"
import { createServer, type Server } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { safeRemoveSync } from "removely"
import { afterEach, describe, expect, it } from "vitest"
import { tribeDaemonCalls } from "../src/service-send.ts"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

/** An unsigned JWT-shaped hab service token: the client reads claims unverified; only the daemon verifies. */
function serviceToken(service: string, sid: string): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
  return `${part({ alg: "EdDSA", typ: "hab-id+jwt" })}.${part({ sid, act: { sub: service, kind: "service" } })}.signature`
}

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

/** The token's actor claim, as the daemon's verifier reads it (act.sub). */
function actorOf(token: string): string | undefined {
  const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as {
    act?: { sub?: string }
  }
  return claims.act?.sub
}

/**
 * A daemon that keys each register on the launch id it was sent and lists that member, and refuses a register whose
 * token names another actor (identity-name-mismatch, as the daemon's with-dispatcher.ts does); it records every call.
 */
async function fakeDaemon(): Promise<{
  socketPath: string
  calls: Array<{ method: string; params: Record<string, unknown> }>
}> {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "tribe-service-send-"))
  const socketPath = join(root, "tribe.sock")
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  let registered: Record<string, unknown> = {}
  const server: Server = createServer((socket) => {
    let buffer = ""
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8")
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (!line.trim()) continue
        const request = JSON.parse(line) as { id: number; method: string; params?: Record<string, unknown> }
        const params = request.params ?? {}
        calls.push({ method: request.method, params })
        let result: unknown = { error: `unexpected call ${request.method}` }
        const actor = typeof params["idToken"] === "string" ? actorOf(params["idToken"]) : undefined
        if (request.method === "register" && actor !== undefined && actor !== params["name"]) {
          const error = {
            code: -32602,
            message: `register refused: this transport claims ${String(params["name"])}, but its identity token names ${actor}`,
            data: { kind: "identity-name-mismatch" },
          }
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error })}\n`)
          continue
        }
        if (request.method === "register") {
          registered = params
          result = {
            name: params["name"],
            role: "member",
            principalClass: params["principalClass"],
            launchId: params["launchId"],
            launchParentPid: process.pid,
          }
        } else if (request.method === "tribe.members") {
          const row = {
            name: registered["name"],
            launch_id: registered["launchId"],
            launch_parent_pid: process.pid,
            transport_state: "connected",
            delivery: "pull",
            alive: true,
            cwd: registered["project"],
          }
          result = { content: [{ text: JSON.stringify({ sessions: [row] }) }] }
        } else if (request.method === "tribe.send") {
          result = { sent: true }
        }
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`)
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(socketPath, () => resolve())
  })
  cleanups.push(() => {
    server.close()
    safeRemoveSync(root, { within: realpathSync(tmpdir()), allowMissing: true })
  })
  return { socketPath, calls }
}

describe("a page producer's send registers on its own hab launch (25074 3d prerequisite)", () => {
  // One row per producer (@cto 6fd50bd0): the register name is the launch's own, the token's actor, never the
  // producer's. quota-wall's job and producer share a name; wait-watch and hab-page are sent by other jobs, so a send
  // that still claimed the producer name would be refused as identity-name-mismatch.
  for (const [producer, job] of [
    ["quota-wall", "quota-wall"],
    ["wait-watch", "attention-watch"],
    ["hab-page", "page-mailbox-projection"],
  ] as const) {
    it(`${producer}, sent by the ${job} job, registers as ${job} on that job's token, never a minted id`, async () => {
      const { socketPath, calls } = await fakeDaemon()
      const token = serviceToken(job, `${job}:1790357359269`)
      const said: string[] = []

      const outcome = await tribeDaemonCalls(producer, {
        socketPath,
        env: { HAB_ID_TOKEN: token },
        say: (line) => said.push(line),
      }).sendAs({ to: "@chief", message: "m" })

      expect(outcome.kind).toBe("ok")
      const register = calls.find((call) => call.method === "register")?.params
      expect(register?.["name"]).toBe(job)
      expect(register?.["idToken"]).toBe(token)
      expect(String(register?.["launchId"]).startsWith(`${job}:1790357359269`)).toBe(true)
      expect(calls.some((call) => call.method === "tribe.send")).toBe(true)
      expect(said).toEqual([])
    })
  }

  it("a process with no token registers on a minted id and says that is the transition 3d deletes", async () => {
    const { socketPath, calls } = await fakeDaemon()
    const said: string[] = []

    const outcome = await tribeDaemonCalls("quota-wall", {
      socketPath,
      env: {},
      say: (line) => said.push(line),
    }).sendAs({
      to: "@chief",
      message: "m",
    })

    expect(outcome.kind).toBe("ok")
    const register = calls.find((call) => call.method === "register")?.params
    expect(register?.["idToken"]).toBeUndefined()
    expect(String(register?.["launchId"]).split("::")[0]).toMatch(UUID)
    expect(said.join("")).toContain("quota-wall: registered on a minted launch id")
    expect(said.join("")).toContain("the transition 25074 3d deletes")
  })
})
