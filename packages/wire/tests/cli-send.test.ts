/**
 * Smoke tests for `registerSendCommands` — Family 2 of Phase A.2 verb-port.
 *
 * Bead: @km/bearly/19231-tribe-cli-unify-phase-a2-verbs
 *
 * These tests verify that each send/messaging verb is registered on the
 * program and accepts its expected flag surface. End-to-end daemon behavior
 * is covered by the legacy tribe-cli integration tests; the focus here is
 * wiring + Commander definitions only.
 */

import { describe, expect, test } from "vitest"
import { Command } from "@silvery/commander"
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { buildSendPayload, registerSendCommands } from "../src/cli/send.ts"

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../src/cli.ts")
const BUN_BIN = process.env.BUN_EXECUTABLE ?? "bun"

function buildProgram(): Command {
  const program = new Command("tribe-test")
  registerSendCommands(program)
  return program
}

function findCmd(program: Command, name: string): Command | undefined {
  return program.commands.find((c) => c.name() === name) as Command | undefined
}

function optionFlags(cmd: Command): string[] {
  // Commander exposes the registered options on `.options`; each entry has a
  // `.long` (e.g. "--limit") and an optional `.short` (e.g. "-n").
  return (cmd.options ?? []).map((o: { long?: string }) => o.long ?? "").filter(Boolean)
}

describe("registerSendCommands", () => {
  test("registers all send/messaging verbs", () => {
    const program = buildProgram()
    const names = program.commands.map((c) => c.name())
    expect(names).toEqual(expect.arrayContaining(["send", "join", "alarm", "alarm-status", "alarm-ack", "retro"]))
  })

  test("send verb is registered with description and message/ball-tracker options", () => {
    const cmd = findCmd(buildProgram(), "send")
    expect(cmd).toBeDefined()
    expect(cmd!.description()).toMatch(/send a message/i)
    // --summary lets a sender author the channel one-liner (20316 #3); LLM
    // senders must provide it, while non-LLM callers may still omit it.
    expect(optionFlags(cmd!)).toEqual(
      expect.arrayContaining(["--type", "--summary", "--reply", "--request", "--fanout"]),
    )
    const summaryOpt = cmd!.options.find((o) => o.long === "--summary")
    expect(summaryOpt?.description).toMatch(/required for llm senders/i)
  })

  test("buildSendPayload keeps the legacy payload shape when ball-tracker flags are omitted", () => {
    expect(buildSendPayload({ to: "@agent/8", message: "hello", type: "notify" })).toEqual({
      to: "@agent/8",
      message: "hello",
      type: "notify",
    })
  })

  test("buildSendPayload forwards request/reply/fanout fields for tribe.send", () => {
    expect(
      buildSendPayload({
        to: "@chief",
        message: "answered",
        type: "response",
        summary: "answered",
        reply: "req-123",
      }),
    ).toEqual({
      to: "@chief",
      message: "answered",
      type: "response",
      summary: "answered",
      reply: "req-123",
    })

    expect(
      buildSendPayload({
        to: "@agent/8",
        message: "please handle",
        type: "request",
        request: true,
        fanout: "all",
      }),
    ).toEqual({
      to: "@agent/8",
      message: "please handle",
      type: "request",
      request: true,
      fanout: "all",
    })

    expect(
      buildSendPayload({
        to: "@agent/8",
        message: "please handle",
        type: "request",
        request: "req-456",
      }),
    ).toMatchObject({ request: "req-456" })
  })

  test("send verb declares <to> and <message...> arguments", () => {
    const cmd = findCmd(buildProgram(), "send")
    expect(cmd).toBeDefined()
    // Commander stores positional args on `_args` (each with `name()` and
    // `variadic` flags). We only need to verify the count + variadic shape.
    const args = (cmd as unknown as { _args?: Array<{ variadic?: boolean }> })._args ?? []
    expect(args.length).toBe(2)
    expect(args[1]!.variadic).toBe(true)
  })

  test("join verb declares <name> and accepts role, domain, delivery, and json flags", () => {
    const cmd = findCmd(buildProgram(), "join")
    expect(cmd).toBeDefined()
    expect(cmd!.description()).toMatch(/join|rejoin/i)
    const args = (cmd as unknown as { _args?: Array<{ variadic?: boolean }> })._args ?? []
    expect(args.length).toBe(1)
    expect(optionFlags(cmd!)).toEqual(expect.arrayContaining(["--role", "--domain", "--delivery", "--json"]))
  })

  test("alarm verb is registered and accepts --by", () => {
    const cmd = findCmd(buildProgram(), "alarm")
    expect(cmd).toBeDefined()
    expect(cmd!.description()).toMatch(/andon-pull|stop-the-line/i)
    expect(optionFlags(cmd!)).toEqual(expect.arrayContaining(["--by"]))
  })

  test("alarm-status verb is registered and accepts --json", () => {
    const cmd = findCmd(buildProgram(), "alarm-status")
    expect(cmd).toBeDefined()
    expect(cmd!.description()).toMatch(/alarm state|no alarm active/i)
    expect(optionFlags(cmd!)).toEqual(expect.arrayContaining(["--json"]))
  })

  test("alarm-ack verb is registered with description", () => {
    const cmd = findCmd(buildProgram(), "alarm-ack")
    expect(cmd).toBeDefined()
    expect(cmd!.description()).toMatch(/clear|unblock/i)
  })

  test("retro verb accepts --since, --format, and --db", () => {
    const cmd = findCmd(buildProgram(), "retro")
    expect(cmd).toBeDefined()
    const flags = optionFlags(cmd!)
    expect(flags).toEqual(expect.arrayContaining(["--since", "--format", "--db"]))
  })

  test("idempotent — each call returns Commander-shaped sub-commands", () => {
    const program = new Command("tribe-test")
    registerSendCommands(program)
    // Sanity: every registered command exposes the standard Commander API.
    for (const c of program.commands) {
      expect(typeof c.name()).toBe("string")
      expect(typeof c.description()).toBe("string")
    }
  })

  test("send --reply reports the daemon's committed tracker result without closing twice (20925)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "tribe-wire-send-reply-"))
    const socketPath = join(tmp, "tribe.sock")
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    const server = createServer((socket) => {
      let buffer = ""
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8")
        let newline = buffer.indexOf("\n")
        while (newline >= 0) {
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          newline = buffer.indexOf("\n")
          if (!line.trim()) continue
          const request = JSON.parse(line) as {
            id: number
            method: string
            params?: Record<string, unknown>
          }
          calls.push({ method: request.method, params: request.params ?? {} })
          const result =
            request.method === "tribe.pending" && request.params?.close === undefined
              ? {
                  content: [
                    {
                      text: JSON.stringify({
                        owner: "@chief",
                        count: 1,
                        pending: [{ request_id: "req-123", sender: "@agent/3" }],
                      }),
                    },
                  ],
                }
              : request.method === "tribe.send"
                ? {
                    sent: true,
                    tracker: { request_id: "req-123", closed: request.params?.message === "done" ? 1 : 0 },
                  }
                : { error: `unexpected duplicate call ${request.method}` }
          socket.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n")
        }
      })
    })

    try {
      await new Promise<void>((resolveListen, rejectListen) => {
        server.once("error", rejectListen)
        server.listen(socketPath, () => {
          server.off("error", rejectListen)
          resolveListen()
        })
      })
      const runReply = (message: string) =>
        new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveProc) => {
          const child = spawn(BUN_BIN, [CLI, "send", "@agent/3", message, "--type", "response", "--reply", "req-123"], {
            env: {
              ...process.env,
              TRIBE_SOCKET: socketPath,
              TRIBE_SESSION_NAME: "@chief",
            },
            stdio: ["ignore", "pipe", "pipe"],
          })
          let stdout = ""
          let stderr = ""
          child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")))
          child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")))
          child.on("close", (code) => resolveProc({ code, stdout, stderr }))
        })

      const res = await runReply("done")

      expect(res).toMatchObject({ code: 0 })
      expect(res.stdout).toContain("Closed 1 pending request row(s) for @chief: req-123")
      expect(res.stdout).toContain("Sent message to @agent/3")

      const unproven = await runReply("unproven")
      expect(unproven.code).toBe(1)
      expect(unproven.stdout).toBe("")
      expect(unproven.stderr).toContain("committed tracker result closed 0 rows for req-123")
      expect(unproven.stderr).toContain("Verify current state with: tribe pending --owner @chief")
      expect(calls).toEqual([
        { method: "tribe.pending", params: { owner: "@chief" } },
        {
          method: "tribe.send",
          params: { to: "@agent/3", message: "done", type: "response", reply: "req-123", sender: "@chief" },
        },
        { method: "tribe.pending", params: { owner: "@chief" } },
        {
          method: "tribe.send",
          params: {
            to: "@agent/3",
            message: "unproven",
            type: "response",
            reply: "req-123",
            sender: "@chief",
          },
        },
      ])
    } finally {
      server.close()
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("send --reply fails loudly when no pending owner identity is available", async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, TRIBE_SOCKET: "/tmp/tribe-wire-no-owner.sock" }
    delete env.TRIBE_NAME
    delete env.TRIBE_SESSION_NAME

    const res = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveProc) => {
      const child = spawn(BUN_BIN, [CLI, "send", "@agent/3", "done", "--type", "response", "--reply", "req-123"], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      })
      let stdout = ""
      let stderr = ""
      child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")))
      child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")))
      child.on("close", (code) => resolveProc({ code, stdout, stderr }))
    })

    expect(res.code).toBe(2)
    expect(res.stdout).toBe("")
    expect(res.stderr).toContain("--reply req-123 requires TRIBE_NAME or TRIBE_SESSION_NAME")
    expect(res.stderr).toContain("Inspect ownership first: tribe pending --owner <owner>")
  })

  test("send forwards TRIBE_NAME as one-shot caller identity", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "tribe-wire-send-identity-"))
    const socketPath = join(tmp, "tribe.sock")
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    const server = createServer((socket) => {
      let buffer = ""
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8")
        let newline = buffer.indexOf("\n")
        while (newline >= 0) {
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          newline = buffer.indexOf("\n")
          if (!line.trim()) continue
          const request = JSON.parse(line) as {
            id: number
            method: string
            params?: Record<string, unknown>
          }
          calls.push({ method: request.method, params: request.params ?? {} })
          socket.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { sent: true } }) + "\n")
        }
      })
    })

    try {
      await new Promise<void>((resolveListen, rejectListen) => {
        server.once("error", rejectListen)
        server.listen(socketPath, () => {
          server.off("error", rejectListen)
          resolveListen()
        })
      })
      const res = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveProc) => {
        const child = spawn(
          BUN_BIN,
          [CLI, "send", "@agent/7", "please", "handle", "this", "--type", "request", "--request"],
          {
            env: {
              ...process.env,
              TRIBE_SOCKET: socketPath,
              TRIBE_NAME: "@chief",
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        )
        let stdout = ""
        let stderr = ""
        child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")))
        child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")))
        child.on("close", (code) => resolveProc({ code, stdout, stderr }))
      })

      expect(res).toMatchObject({ code: 0 })
      expect(res.stdout).toContain("Sent message to @agent/7")
      expect(calls).toEqual([
        {
          method: "tribe.send",
          params: {
            to: "@agent/7",
            message: "please handle this",
            type: "request",
            request: true,
            sender: "@chief",
          },
        },
      ])
    } finally {
      server.close()
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
