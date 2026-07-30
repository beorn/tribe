/**
 * Smoke tests for `registerSendCommands` — Family 2 of Phase A.2 verb-port.
 *
 * Bead: @km/bearly/19231-tribe-cli-unify-phase-a2-verbs
 *
 * These tests verify registration, flag shape, and spawned CLI behavior. The
 * real-daemon takeover journey lives in actionable-recovery-journey.test.ts.
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
      expect.arrayContaining([
        "--type",
        "--summary",
        "--delivery",
        "--ref",
        "--reply",
        "--request",
        "--fanout",
        "--expires-in-ms",
      ]),
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

  test("buildSendPayload forwards delivery and ball-tracker fields for tribe.send", () => {
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
        delivery: "pull",
        ref: "ball-controller:v1:rescue-page:@agent%2F8:epoch-1",
        request: true,
        fanout: "all",
        expiresInMs: 600_000,
      }),
    ).toEqual({
      to: "@agent/8",
      message: "please handle",
      type: "request",
      delivery: "pull",
      ref: "ball-controller:v1:rescue-page:@agent%2F8:epoch-1",
      request: true,
      fanout: "all",
      expires_in_ms: 600_000,
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

  test("one-shot join checkpoints the persistent member without registering a disposable member", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "tribe-wire-join-checkpoint-"))
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
          socket.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: request.id,
              result: {
                joined: true,
                observed: true,
                name: "@agent/8",
                role: "member",
                domains: ["test-lean"],
                delivery: "pull",
              },
            }) + "\n",
          )
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
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveProcess) => {
        const child = spawn(
          BUN_BIN,
          [CLI, "join", "@agent/8", "--domain", "test-lean", "--delivery", "pull", "--json"],
          {
            env: {
              ...process.env,
              TRIBE_SOCKET: socketPath,
              TRIBE_NAME: "@agent/8",
              TRIBE_TAKEOVER: "1",
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        )
        let stdout = ""
        let stderr = ""
        child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")))
        child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")))
        child.on("close", (code) => resolveProcess({ code, stdout, stderr }))
      })

      expect(result).toMatchObject({ code: 0, stderr: "" })
      expect(JSON.parse(result.stdout)).toMatchObject({ joined: true, observed: true, name: "@agent/8" })
      expect(calls).toEqual([
        {
          method: "cli_join",
          params: { name: "@agent/8", role: "member", domains: ["test-lean"], delivery: "pull" },
        },
      ])
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("one-shot join exits nonzero when no persistent holder exists, including with --json", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "tribe-wire-join-missing-"))
    const socketPath = join(tmp, "tribe.sock")
    const server = createServer((socket) => {
      let buffer = ""
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8")
        const newline = buffer.indexOf("\n")
        if (newline < 0) return
        const request = JSON.parse(buffer.slice(0, newline)) as { id: number }
        socket.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: {
              joined: false,
              observed: false,
              error: "one-shot CLI cannot establish persistent membership for @agent/missing",
            },
          }) + "\n",
        )
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
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveProcess) => {
        const child = spawn(BUN_BIN, [CLI, "join", "@agent/missing", "--json"], {
          env: { ...process.env, TRIBE_SOCKET: socketPath },
          stdio: ["ignore", "pipe", "pipe"],
        })
        let stdout = ""
        let stderr = ""
        child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")))
        child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")))
        child.on("close", (code) => resolveProcess({ code, stdout, stderr }))
      })

      expect(result.code).toBe(1)
      expect(result.stdout).toBe("")
      expect(result.stderr).toContain("one-shot CLI cannot establish persistent membership")
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
      rmSync(tmp, { recursive: true, force: true })
    }
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
    let pendingOpen = true
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
          let result: unknown
          if (request.method === "tribe.pending" && request.params?.close === undefined) {
            result = {
              content: [
                {
                  text: JSON.stringify({
                    owner: "@chief",
                    count: pendingOpen ? 1 : 0,
                    pending: pendingOpen ? [{ request_id: "req-123", message_id: "msg-123", sender: "@agent/3" }] : [],
                  }),
                },
              ],
            }
          } else if (request.method === "tribe.pending" && request.params?.close === "req-123") {
            const closed = pendingOpen ? 1 : 0
            pendingOpen = false
            result = {
              structuredContent: {
                owner: "@chief",
                request_id: "req-123",
                closed,
                ...(closed === 0
                  ? {
                      warning:
                        "reply/close req-123 closed 0 rows; balls owned by @chief: req-other (message msg-other, from @agent/4)",
                    }
                  : {}),
              },
            }
          } else if (request.method === "register") {
            // Mirror the real daemon's grant: the one-shot --reply register gets
            // the requested name back (no live holder in this fixture).
            result = { name: (request.params?.name as string) ?? "@chief", role: "member" }
          } else if (request.method === "tribe.send") {
            pendingOpen = false
            const message = request.params?.message
            result =
              message === "missing"
                ? { sent: true }
                : {
                    sent: true,
                    tracker: {
                      request_id: "req-123",
                      closed: message === "done" || message === "by-message" ? 1 : message === "malformed" ? 1.5 : 0,
                    },
                  }
          } else {
            result = { error: `unexpected call ${request.method}` }
          }
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
      const runCli = (args: string[]) =>
        new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveProc) => {
          const child = spawn(BUN_BIN, [CLI, ...args], {
            env: {
              ...process.env,
              TRIBE_SOCKET: socketPath,
              TRIBE_SESSION_NAME: "@chief",
              TRIBE_LAUNCH_ID: "",
            },
            stdio: ["ignore", "pipe", "pipe"],
          })
          let stdout = ""
          let stderr = ""
          child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")))
          child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")))
          child.on("close", (code) => resolveProc({ code, stdout, stderr }))
        })
      const runReply = (message: string, reply = "req-123") =>
        runCli(["send", "@agent/3", message, "--type", "response", "--reply", reply])

      const byMessage = await runReply("by-message", "msg-123")
      expect(byMessage).toMatchObject({ code: 0, stderr: "" })
      expect(byMessage.stdout).toContain("Closed 1 pending request row(s) for @chief: req-123")

      pendingOpen = true

      const res = await runReply("done")

      expect(res).toMatchObject({ code: 0 })
      expect(res.stdout).toContain("Closed 1 pending request row(s) for @chief: req-123")
      expect(res.stdout).toContain("Sent message to @agent/3")
      expect(res.stderr).not.toContain("did not close")

      // Literal 2026-07-12 repro: the reply already closed @chief's ball.
      // A later explicit/manual close therefore returns 0; that must not make
      // the earlier reply CLI retroactively print a false failure.
      const manualClose = await runCli(["pending", "--owner", "@chief", "--close", "req-123"])
      expect(manualClose.code).toBe(0)
      expect(manualClose.stdout).toContain("Closed 0 pending request(s) for @chief: req-123")
      expect(manualClose.stderr).toContain(
        "reply/close req-123 closed 0 rows; balls owned by @chief: req-other (message msg-other, from @agent/4)",
      )

      pendingOpen = true
      const unproven = await runReply("unproven")
      expect(unproven.code).toBe(1)
      expect(unproven.stdout).toBe("")
      expect(unproven.stderr).toContain("committed tracker result closed 0 rows for req-123")
      expect(unproven.stderr).toContain("Verify current state with: tribe pending --owner @chief")

      pendingOpen = true
      const missing = await runReply("missing")
      expect(missing.code).toBe(1)
      expect(missing.stdout).toBe("")
      expect(missing.stderr).toContain("response sent, but the daemon returned no committed tracker proof for req-123")
      expect(missing.stderr).toContain("Verify current state with: tribe pending --owner @chief")

      pendingOpen = true
      const malformed = await runReply("malformed")
      expect(malformed.code).toBe(1)
      expect(malformed.stdout).toBe("")
      expect(malformed.stderr).toContain("response sent, but the daemon returned malformed committed tracker proof")
      expect(malformed.stderr).toContain("Verify current state with: tribe pending --owner @chief")

      const closes = calls.filter((call) => call.method === "tribe.pending" && call.params.close !== undefined)
      expect(closes).toEqual([{ method: "tribe.pending", params: { owner: "@chief", close: "req-123" } }])
      expect(calls.filter((call) => call.method === "tribe.send")).toHaveLength(5)
    } finally {
      server.close()
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("send --reply fails loudly when no pending owner identity is available", async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, TRIBE_SOCKET: "/tmp/tribe-wire-no-owner.sock" }
    delete env.TRIBE_NAME
    delete env.TRIBE_SESSION_NAME
    delete env.TRIBE_LAUNCH_ID

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

  test("send rejects prose-shaped reply/ref intent before daemon I/O and teaches the structured flag", async () => {
    const socketPath = join(tmpdir(), `tribe-wire-intent-guard-${process.pid}.sock`)
    const runSend = (message: string, flags: string[] = []) =>
      new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveProc) => {
        const child = spawn(BUN_BIN, [CLI, "send", "@agent/3", message, ...flags], {
          env: {
            ...process.env,
            TRIBE_SOCKET: socketPath,
            TRIBE_NAME: "@chief",
            TRIBE_LAUNCH_ID: "",
          },
          stdio: ["ignore", "pipe", "pipe"],
        })
        let stdout = ""
        let stderr = ""
        child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")))
        child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")))
        child.on("close", (code) => resolveProc({ code, stdout, stderr }))
      })

    const reply = await runSend("  reply=req-123 answered")
    expect(reply).toMatchObject({ code: 2, stdout: "" })
    expect(reply.stderr).toContain("message content begins with reply=req-123")
    expect(reply.stderr).toContain("Use --reply req-123")
    expect(reply.stderr).not.toContain("No daemon running")

    const ref = await runSend("ref=incident-7 checkpoint")
    expect(ref).toMatchObject({ code: 2, stdout: "" })
    expect(ref.stderr).toContain("message content begins with ref=incident-7")
    expect(ref.stderr).toContain("Use --ref incident-7")
    expect(ref.stderr).not.toContain("No daemon running")

    const prose = await runSend("checkpoint mentions reply=req-123 in ordinary prose")
    expect(prose.code).toBe(1)
    expect(prose.stderr).toContain("No daemon running")
    expect(prose.stderr).not.toContain("message content begins with")

    const structured = await runSend("answered", ["--type", "response", "--reply", "req-123"])
    expect(structured.code).toBe(1)
    expect(structured.stderr).toContain("No daemon running")
    expect(structured.stderr).not.toContain("message content begins with")

    const mismatched = await runSend("reply=req-A answered", ["--type", "response", "--reply", "req-B"])
    expect(mismatched).toMatchObject({ code: 2, stdout: "" })
    expect(mismatched.stderr).toContain("message content begins with reply=req-A")
    expect(mismatched.stderr).toContain("remove reply=req-A from the message content")
    expect(mismatched.stderr).not.toContain("No daemon running")
  })

  // @ag/tribe/21921 — P0 REGRESSION PIN. The launch row can be ABSENT
  // (getSessionsByLaunchId -> 0 rows), and every `ag code` seat carries
  // TRIBE_LAUNCH_ID, so an unconditional exit on that path removes sending
  // entirely. Eight seats went mute on 2026-07-22 while reads kept working,
  // because reads resolve an explicit target and never need the caller's own
  // identity. The daemon-side launch-tuple fix (f2f4cc02) repairs the case
  // where a session IS returned; this pins the case where none is.
  test("a NON-REPLY send survives an unresolvable launch identity (degrades to anonymous)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "tribe-wire-send-stale-launch-"))
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
          const request = JSON.parse(line) as { id: number; method: string; params?: Record<string, unknown> }
          calls.push({ method: request.method, params: request.params ?? {} })
          const result = request.method === "cli_inbox_status_by_launch_v1" ? {} : { sent: true }
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
      const res = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveProc) => {
        const child = spawn(BUN_BIN, [CLI, "send", "@agent/7", "still", "reachable"], {
          env: {
            ...process.env,
            TRIBE_SOCKET: socketPath,
            TRIBE_NAME: "@chief",
            TRIBE_LAUNCH_ID: "launch-id-with-no-stored-session",
          },
          stdio: ["ignore", "pipe", "pipe"],
        })
        let stdout = ""
        let stderr = ""
        child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")))
        child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")))
        child.on("close", (code) => resolveProc({ code, stdout, stderr }))
      })

      expect(res).toMatchObject({ code: 0 })
      expect(res.stdout).toContain("Sent message to @agent/7")
      expect(res.stderr).toContain("launch-id-with-no-stored-session")
      // Degrading must not fall back to the env name (21717 anti-spoof).
      expect(calls.some((c) => c.method === "register")).toBe(false)
      expect(calls.some((c) => c.method === "tribe.send")).toBe(true)
    } finally {
      server.close()
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("a REPLY send still refuses an unresolvable launch identity", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "tribe-wire-send-stale-launch-reply-"))
    const socketPath = join(tmp, "tribe.sock")
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
          const request = JSON.parse(line) as { id: number; method: string }
          const result = request.method === "cli_inbox_status_by_launch_v1" ? {} : { sent: true }
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
      const res = await new Promise<{ code: number | null; stderr: string }>((resolveProc) => {
        const child = spawn(
          BUN_BIN,
          [CLI, "send", "@agent/7", "answered", "--type", "response", "--reply", "req-123"],
          {
            env: {
              ...process.env,
              TRIBE_SOCKET: socketPath,
              TRIBE_NAME: "@chief",
              TRIBE_LAUNCH_ID: "launch-id-with-no-stored-session",
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        )
        let stderr = ""
        child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")))
        child.on("close", (code) => resolveProc({ code, stderr }))
      })

      expect(res.code).toBe(1)
      expect(res.stderr).toContain("req-123")
    } finally {
      server.close()
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("two CLI --request true sends from different senders forward boolean tracking requests", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "tribe-wire-send-request-true-"))
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
      const runSend = (sender: string, message: string) =>
        new Promise<{ code: number | null; stderr: string }>((resolveProc) => {
          const child = spawn(BUN_BIN, [CLI, "send", "@reviewer", message, "--type", "notify", "--request", "true"], {
            env: {
              ...process.env,
              TRIBE_SOCKET: socketPath,
              TRIBE_NAME: sender,
              TRIBE_LAUNCH_ID: "",
            },
            stdio: ["ignore", "ignore", "pipe"],
          })
          let stderr = ""
          child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")))
          child.on("close", (code) => resolveProc({ code, stderr }))
        })

      expect(await runSend("@sender/1", "first")).toEqual({ code: 0, stderr: "" })
      expect(await runSend("@sender/2", "second")).toEqual({ code: 0, stderr: "" })
      expect(calls).toEqual([
        {
          method: "tribe.send",
          params: {
            to: "@reviewer",
            message: "first",
            type: "notify",
            request: true,
          },
        },
        {
          method: "tribe.send",
          params: {
            to: "@reviewer",
            message: "second",
            type: "notify",
            request: true,
          },
        },
      ])
    } finally {
      server.close()
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("send does not forward TRIBE_NAME as a caller-authored identity", async () => {
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
              TRIBE_LAUNCH_ID: "",
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
          },
        },
      ])
    } finally {
      server.close()
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
