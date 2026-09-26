/**
 * @failure  a producer registers on a launch id nobody gave it: a hab job's page producer on a minted id with no
 *           token, a seat-run producer under its own name beside the seat, or a tokenless hand run as a claimed
 *           producer, so no send says who really sent it
 * @level    l1
 * @consumer @i/2-agent-launch/25074-hab-signs-one-identity-token-per-launch (3d-1c, @cto 082a4259)
 * @testonly none
 *
 * sendAs is the one sender every non-seat producer shares. A hab service's token registers as that service, on its
 * token. A seat's token registers as the seat under the daemon's own launch tuple, so the send fans into the live
 * seat. No token refuses before the daemon, naming HAB_ID_TOKEN, the producer and the cure; nothing is minted.
 */
import { mkdtempSync, realpathSync } from "node:fs"
import { createServer, type Server } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { safeRemoveSync } from "removely"
import { afterEach, describe, expect, it } from "vitest"
import { launchSender, tribeDaemonCalls } from "../src/service-send.ts"
import { launchToken } from "./launch-token.ts"

const SEAT = "@dev/2"
const SEAT_SID = "7b1c0d2e-seat-sid"
/** The launch tuple the daemon keeps for the seat: its verified `<sid>@<gen>` key and the harness's pid. */
const SEAT_TUPLE = { launch_id: `${SEAT_SID}@3`, launch_parent_pid: 4242 }

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
        } else if (request.method === "cli_inbox_status_by_launch_v1") {
          result =
            params["launch_id"] === SEAT_SID
              ? { content: [{ text: JSON.stringify({ session: SEAT, ...SEAT_TUPLE }) }] }
              : {
                  content: [
                    { text: JSON.stringify({ error: `no session holds launch ${String(params["launch_id"])}` }) },
                  ],
                }
        } else if (request.method === "tribe.send") {
          // The daemon refuses a send in-band: a JSON-RPC result whose content carries `error` (handlers.ts handleSend).
          result =
            params["message"] === "refuse me"
              ? { content: [{ text: JSON.stringify({ error: "tribe.send: invalid incident - subject is empty" }) }] }
              : { content: [{ text: JSON.stringify({ sent: true }) }] }
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

describe("the one sender registers as what its launch's token names (25074 3d-1c)", () => {
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
      const token = launchToken(`${job}:1790357359269`, job, "service")

      const outcome = await tribeDaemonCalls(producer, {
        socketPath,
        env: { HAB_ID_TOKEN: token },
      }).sendAs({ to: "@chief", message: "m" })

      expect(outcome.kind).toBe("ok")
      const register = calls.find((call) => call.method === "register")?.params
      expect(register?.["name"]).toBe(job)
      expect(register?.["idToken"]).toBe(token)
      expect(String(register?.["launchId"]).startsWith(`${job}:1790357359269`)).toBe(true)
      expect(calls.some((call) => call.method === "tribe.send")).toBe(true)
    })
  }

  it("a seat-run producer registers as the seat under the daemon's launch tuple, presenting no token of its own", async () => {
    const { socketPath, calls } = await fakeDaemon()

    const outcome = await tribeDaemonCalls("onfail", {
      socketPath,
      env: { HAB_ID_TOKEN: launchToken(SEAT_SID, SEAT) },
    }).sendAs({ to: "@chief", message: "m" })

    expect(outcome, JSON.stringify(outcome)).toMatchObject({ kind: "ok" })
    expect(calls.map((call) => call.method)).toEqual(["cli_inbox_status_by_launch_v1", "register", "tribe.send"])
    expect(calls[0]?.params).toEqual({ launch_id: SEAT_SID, persona: SEAT })
    expect(calls[1]?.params).toMatchObject({
      name: SEAT,
      launchId: SEAT_TUPLE.launch_id,
      launchParentPid: SEAT_TUPLE.launch_parent_pid,
    })
    expect(calls[1]?.params).not.toHaveProperty("idToken")
  })

  it("a process with no token is refused before the daemon, naming HAB_ID_TOKEN, the producer and the cure", async () => {
    const { socketPath, calls } = await fakeDaemon()

    const outcome = await tribeDaemonCalls("quota-wall", { socketPath, env: {} }).sendAs({ to: "@chief", message: "m" })

    expect(outcome.kind).toBe("error")
    const message = outcome.kind === "error" ? outcome.message : ""
    expect(message).toMatch(/^quota-wall: no identity token \(HAB_ID_TOKEN\) to send as; run it from a hab seat/)
    expect(calls).toEqual([])
  })

  it("a send the daemon refuses in-band is a refused outcome carrying the refusal, never ok", async () => {
    const { socketPath } = await fakeDaemon()

    const outcome = await tribeDaemonCalls("onfail", {
      socketPath,
      env: { HAB_ID_TOKEN: launchToken(SEAT_SID, SEAT) },
    }).sendAs({ to: "@chief", message: "refuse me" })

    expect(outcome).toEqual({ kind: "refused", refusal: "tribe.send: invalid incident - subject is empty" })
  })

  it("a tokenless standalone caller of launchSender fails by name, with no daemon to ask", () => {
    expect(() => launchSender("standalone-tool", {})).toThrow(
      /^standalone-tool: no identity token \(HAB_ID_TOKEN\) to send as; run it from a hab seat, or as the hab service/,
    )
  })

  it("a malformed token is refused before the daemon, by name", async () => {
    const { socketPath, calls } = await fakeDaemon()

    const outcome = await tribeDaemonCalls("quota-wall", { socketPath, env: { HAB_ID_TOKEN: "not-a-jwt" } }).sendAs({
      to: "@chief",
      message: "m",
    })

    expect(outcome.kind === "error" ? outcome.message : "").toMatch(/^quota-wall: HAB_ID_TOKEN is malformed: /)
    expect(calls).toEqual([])
  })
})
