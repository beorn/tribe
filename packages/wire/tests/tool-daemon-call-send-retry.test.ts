/**
 * @failure An MCP tribe.send whose daemon connection closes mid-send is
 *   dropped: the caller gets a reconnect-health string (or a closed-socket
 *   rejection) and the message never reaches the daemon, learned only from
 *   outbound history (28900, retro F-23).
 * @level l1 — fake DaemonClient at the callTribeTool boundary both adapters share.
 * @consumer @ag/tribe/28900; stdio + http MCP adapters via callTribeTool.
 * @testonly none
 */
import { mkdtempSync, rmSync } from "node:fs"
import { createServer, type Server, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it, vi } from "vitest"

import { createReconnectingClient, type DaemonClient } from "../src/client.ts"
import { createLineParser } from "../src/parser.ts"
import { isRequest, makeResponse } from "../src/rpc.ts"
import { callTribeTool } from "../src/lib/tool-daemon-call.ts"

const SEND_ARGS = { to: "@chief", message: "hello", type: "notify", summary: "hi" }
const OK = { content: [{ type: "text", text: JSON.stringify({ sent: true, id: "daemon-id" }) }] }

function fakeClient(call: (...args: never[]) => Promise<unknown>): DaemonClient {
  return { call } as unknown as DaemonClient
}

describe("callTribeTool send on a closed daemon connection (28900)", () => {
  it("retries once after a closed connection and returns the daemon result, same message_id", async () => {
    const call = vi
      .fn()
      .mockRejectedValueOnce(new Error("daemon connection closed; reconnecting"))
      .mockResolvedValueOnce(OK)
    const result = await callTribeTool(fakeClient(call), "send", { ...SEND_ARGS }, { sendRetryDelayMs: 1 })
    expect(result).toEqual(OK)
    expect(call).toHaveBeenCalledTimes(2)
    const first = call.mock.calls[0]![1] as Record<string, unknown>
    const second = call.mock.calls[1]![1] as Record<string, unknown>
    expect(typeof first.message_id).toBe("string")
    expect(second.message_id).toBe(first.message_id)
  })

  it("retries a mid-flight Connection closed rejection (write may have committed; id dedupes)", async () => {
    const call = vi.fn().mockRejectedValueOnce(new Error("Connection closed")).mockResolvedValueOnce(OK)
    await expect(
      callTribeTool(fakeClient(call), "send", { ...SEND_ARGS, message_id: "client-uuid-1" }, { sendRetryDelayMs: 1 }),
    ).resolves.toEqual(OK)
    expect(call).toHaveBeenCalledTimes(2)
    expect((call.mock.calls[1]![1] as Record<string, unknown>).message_id).toBe("client-uuid-1")
  })

  it("fails loud with UNKNOWN acceptance and the message_id when the connection never recovers", async () => {
    const call = vi.fn().mockRejectedValue(new Error("daemon connection closed; reconnecting"))
    const failure = await callTribeTool(
      fakeClient(call),
      "send",
      { ...SEND_ARGS },
      { sendRetryDelayMs: 1, sendRetryDeadlineMs: 20 },
    ).catch((err: unknown) => err)
    expect(failure).toBeInstanceOf(Error)
    const text = (failure as Error).message
    expect(text).toContain("stop_reason=daemon connection closed")
    // M1: the first write may have committed — never claim "not sent"; carry
    // the id so the caller's own retry dedupes instead of duplicating.
    expect(text).toContain("it may have been written")
    expect(text).not.toContain("was not sent")
    const usedId = (call.mock.calls[0]![1] as Record<string, unknown>).message_id
    expect(text).toContain(`retry under message_id ${String(usedId)}`)
    expect(call.mock.calls.length).toBeGreaterThan(1)
  })

  it("bounds a slow retry by the remaining window, then reports unknown acceptance", async () => {
    const timeoutError = Object.assign(new Error("Request tribe.send timed out after 20ms"), {
      name: "DaemonCallTimeoutError",
      code: "TRIBE_DAEMON_CALL_TIMEOUT",
    })
    const call = vi
      .fn()
      .mockRejectedValueOnce(new Error("Connection closed"))
      .mockImplementationOnce(
        (_method: string, _args: unknown, opts?: { timeoutMs?: number }) =>
          new Promise((_resolve, reject) => {
            setTimeout(() => reject(timeoutError), opts?.timeoutMs ?? 60)
          }),
      )
    const failure = await callTribeTool(
      fakeClient(call),
      "send",
      { ...SEND_ARGS },
      { sendRetryDelayMs: 1, sendRetryDeadlineMs: 30 },
    ).catch((err: unknown) => err)
    expect((failure as Error).message).toContain("it may have been written")
    expect(call).toHaveBeenCalledTimes(2)
    const retryOpts = call.mock.calls[1]![2] as { timeoutMs: number }
    expect(retryOpts.timeoutMs).toBeGreaterThan(0)
    expect(retryOpts.timeoutMs).toBeLessThanOrEqual(30)
  })

  it("passes a supplied blank message_id through to the daemon refusal, never normalizing it", async () => {
    const call = vi.fn().mockRejectedValue(new Error("tribe.send: invalid message_id"))
    await expect(
      callTribeTool(fakeClient(call), "send", { ...SEND_ARGS, message_id: "" }, { sendRetryDelayMs: 1 }),
    ).rejects.toThrow("invalid message_id")
    expect(call).toHaveBeenCalledTimes(1)
    expect((call.mock.calls[0]![1] as Record<string, unknown>).message_id).toBe("")
  })

  it("does not retry a daemon refusal that is not a closed connection", async () => {
    const call = vi.fn().mockRejectedValue(new Error("tribe.send: invalid message_id"))
    await expect(callTribeTool(fakeClient(call), "send", { ...SEND_ARGS }, { sendRetryDelayMs: 1 })).rejects.toThrow(
      "invalid message_id",
    )
    expect(call).toHaveBeenCalledTimes(1)
  })

  it("does not invent a message_id or retry for recipient lists (daemon refuses ids there)", async () => {
    const call = vi.fn().mockRejectedValue(new Error("daemon connection closed; reconnecting"))
    await expect(
      callTribeTool(fakeClient(call), "send", { ...SEND_ARGS, to: ["@a", "@b"] }, { sendRetryDelayMs: 1 }),
    ).rejects.toThrow(/daemon connection closed/)
    expect(call).toHaveBeenCalledTimes(1)
    expect((call.mock.calls[0]![1] as Record<string, unknown>).message_id).toBeUndefined()
  })

  // M2 SHOULD: the REAL reconnecting client against a socket that closes on
  // the first tribe.send — the retry fires on the successor connection under
  // the same message_id, proving the predicate matches live throw sites.
  it("retries through the real reconnecting client when the socket closes mid-send", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tribe-send-retry-"))
    const sock = join(dir, "daemon.sock")
    const seenIds: unknown[] = []
    let connections = 0
    const server: Server = createServer((socket: Socket) => {
      connections++
      const mine = connections
      socket.on(
        "data",
        createLineParser((msg) => {
          if (!isRequest(msg)) return
          if (msg.method === "tribe.send") {
            seenIds.push((msg.params as Record<string, unknown>).message_id)
            if (mine === 1) {
              socket.destroy()
              return
            }
            socket.write(
              makeResponse(msg.id, {
                content: [{ type: "text", text: JSON.stringify({ sent: true, id: seenIds.at(-1) }) }],
              }),
            )
            return
          }
          socket.write(makeResponse(msg.id, null))
        }),
      )
      socket.on("error", () => {})
    })
    await new Promise<void>((resolve) => {
      server.listen(sock, () => resolve())
    })
    const client = await createReconnectingClient({ socketPath: sock, noSpawn: true, maxAttempts: 5 })
    try {
      const result = (await callTribeTool(
        client,
        "send",
        { ...SEND_ARGS },
        { sendRetryDelayMs: 10, sendRetryDeadlineMs: 5_000 },
      )) as { content: Array<{ text: string }> }
      expect(result.content[0]!.text).toContain('"sent":true')
      expect(seenIds).toHaveLength(2)
      expect(typeof seenIds[0]).toBe("string")
      expect(seenIds[1]).toBe(seenIds[0])
    } finally {
      client.close()
      server.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
