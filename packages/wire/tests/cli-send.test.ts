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
import { mkdtempSync, realpathSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { buildSendPayload, registerSendCommands } from "../src/cli/send.ts"
import { AG_SESSION_AUTH_ENV } from "../src/lib/self-mailbox-authority.ts"
import { oversizedMessageError } from "../src/lib/send-validation.ts"
import { safeRemoveSync } from "removely"

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../src/cli.ts")
const BUN_BIN = process.env.BUN_EXECUTABLE ?? "bun"
const TEST_ROOT = realpathSync(tmpdir())

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
  test("client rejects oversize content with byte count and a file+SHA pointer", () => {
    const message = "🙂".repeat(2_050)
    const error = oversizedMessageError(message)

    expect(error).toContain(`${Buffer.byteLength(message, "utf8")} UTF-8 bytes`)
    expect(error).toMatch(/file:\/\/\/absolute\/path\/to\/message sha256:[0-9a-f]{64}/u)
  })

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
        "--anonymous",
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

  // habwire stage 2(d): the CLI is one of the two emitter-facing rails, so the
  // key it accepts must parse into the same identity the daemon keys the ball
  // on. A malformed key has to fail HERE, with the shape named — reaching the
  // daemon as a mystery refusal is how a watcher silently stops obligating.
  test("buildSendPayload parses --incident into the structured identity", () => {
    expect(
      buildSendPayload({
        to: "@chief",
        message: "seat wedged",
        type: "notify",
        incident: "health-monitor:@dev/5:transport-wedged",
      }),
    ).toEqual({
      to: "@chief",
      message: "seat wedged",
      type: "notify",
      incident: { emitter: "health-monitor", subject: "@dev/5", condition: "transport-wedged" },
    })
  })

  test("buildSendPayload marks the clearing edge so the ball closes", () => {
    expect(
      buildSendPayload({
        to: "@chief",
        message: "seat recovered",
        type: "notify",
        incident: "health-monitor:@dev/5:transport-wedged",
        incidentCleared: true,
      }).incident,
    ).toEqual({
      emitter: "health-monitor",
      subject: "@dev/5",
      condition: "transport-wedged",
      active: false,
    })
  })

  test("buildSendPayload rejects a malformed or under-specified incident key", () => {
    for (const bad of ["health-monitor:@dev/5", "health-monitor::transport-wedged", "just-one-part"]) {
      expect(() => buildSendPayload({ to: "@chief", message: "x", type: "notify", incident: bad })).toThrow(
        /emitter.*subject.*condition/is,
      )
    }
  })

  test("buildSendPayload refuses a clearing edge that names no condition", () => {
    // Silently ignoring this would report a successful send while the ball
    // stayed open — the failure looks like success.
    expect(() =>
      buildSendPayload({ to: "@chief", message: "recovered", type: "notify", incidentCleared: true }),
    ).toThrow(/requires --incident/i)
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

  test("human send output names the effective holder and fails loud on malformed redirect proof", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "tribe-wire-send-holder-"))
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
          const request = JSON.parse(line) as { id: number; method: string; params?: { message?: string } }
          const result =
            request.method === "cli_inbox_status_by_launch_v1"
              ? { session: "@dev/2", launch_id: "launch-dev2", launch_parent_pid: 123 }
              : request.method === "register"
                ? { name: "@dev/2", role: "member" }
                : request.method === "tribe.send"
                  ? {
                      sent: true,
                      delivery: {
                        state: "bounced",
                        original_target: "@ci",
                        ...(request.params?.message === "malformed proof" ? {} : { recipient: "@chief" }),
                        reason: "no answer-capable transport observed for @ci; matched exact name @ci",
                      },
                    }
                  : { error: `unexpected call ${request.method}` }
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`)
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
      const runSend = (message: string[]) =>
        new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveProcess) => {
          const child = spawn(
            BUN_BIN,
            [CLI, "send", "@ci", ...message, "--type", "request", "--summary", "landing request"],
            {
              env: { ...process.env, TRIBE_SOCKET: socketPath, TRIBE_LAUNCH_ID: "launch-dev2" },
              stdio: ["ignore", "pipe", "pipe"],
            },
          )
          let stdout = ""
          let stderr = ""
          child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")))
          child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")))
          child.on("close", (code) => resolveProcess({ code, stdout, stderr }))
        })

      const sent = await runSend(["please", "land", "this"])

      expect(sent).toMatchObject({ code: 0, stderr: "" })
      expect(sent.stdout).toContain("Sent message to @chief")
      expect(sent.stdout).toContain("redirected from @ci")
      expect(sent.stdout).not.toContain("Sent message to @ci\n")

      const malformed = await runSend(["malformed", "proof"])
      expect(malformed.code).toBe(3)
      expect(malformed.stdout).toBe("")
      expect(malformed.stderr).toContain("message DELIVERED, but the daemon returned malformed redirect proof")
      expect(malformed.stderr).toContain("Inspect the recipient mailbox and daemon delivery policy before retrying.")
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
      safeRemoveSync(tmp, { within: TEST_ROOT, allowMissing: true })
    }
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
      safeRemoveSync(tmp, { within: TEST_ROOT, allowMissing: true })
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
      safeRemoveSync(tmp, { within: TEST_ROOT, allowMissing: true })
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
          } else if (request.method === "cli_session_pending_close_v1" && request.params?.close === "req-123") {
            if (request.params.authority == null) {
              socket.write(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: request.id,
                  error: {
                    code: -32004,
                    message:
                      "current session authority is missing; AG_SESSION_AUTH must be inherited from the managed launch",
                    data: {
                      kind: "could-not-evaluate",
                      reason: "session-authority-missing",
                      refusal_event_id: "refused-missing-authority",
                    },
                  },
                }) + "\n",
              )
              continue
            }
            const closed = pendingOpen ? 1 : 0
            pendingOpen = false
            result = {
              structuredContent: {
                owner: "@chief",
                request_id: "req-123",
                closed,
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
      const runCli = (args: string[], authority?: string) =>
        new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveProc) => {
          const env: NodeJS.ProcessEnv = {
            ...process.env,
            TRIBE_SOCKET: socketPath,
            TRIBE_SESSION_NAME: "@chief",
            TRIBE_LAUNCH_ID: "",
          }
          delete env[AG_SESSION_AUTH_ENV]
          if (authority !== undefined) env[AG_SESSION_AUTH_ENV] = authority
          const child = spawn(BUN_BIN, [CLI, ...args], {
            env,
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

      // Carrier 2: an unmanaged explicit close reaches the daemon without a
      // session authority, is refused there, and leaves the open row intact.
      pendingOpen = true
      const missingAuthorityClose = await runCli(["pending", "--owner", "@chief", "--close", "req-123"])
      expect(missingAuthorityClose.code).toBe(1)
      expect(missingAuthorityClose.stdout).toBe("")
      expect(missingAuthorityClose.stderr).toContain(`${AG_SESSION_AUTH_ENV} must be inherited from the managed launch`)
      expect(pendingOpen).toBe(true)

      const authority = "a".repeat(43)
      const authenticatedClose = await runCli(["pending", "--owner", "@chief", "--close", "req-123"], authority)
      expect(authenticatedClose).toMatchObject({ code: 0, stderr: "" })
      expect(authenticatedClose.stdout).toContain("Closed 1 pending request(s) for @chief: req-123")

      // 22844: every branch below reports on the bookkeeping half of an
      // ALREADY-DELIVERED response — exit 3 (delivered, close unconfirmed),
      // never exit 1 (not delivered), and the wording says DELIVERED.
      pendingOpen = true
      const unproven = await runReply("unproven")
      expect(unproven.code).toBe(3)
      expect(unproven.stdout).toBe("")
      expect(unproven.stderr).toContain("response DELIVERED")
      expect(unproven.stderr).toContain("committed tracker result closed 0 rows for req-123")
      expect(unproven.stderr).toContain("Verify current state with: tribe pending --owner @chief")

      pendingOpen = true
      const missing = await runReply("missing")
      expect(missing.code).toBe(3)
      expect(missing.stdout).toBe("")
      expect(missing.stderr).toContain(
        "response DELIVERED, but the daemon returned no committed tracker proof for req-123",
      )
      expect(missing.stderr).toContain("Verify current state with: tribe pending --owner @chief")

      pendingOpen = true
      const malformed = await runReply("malformed")
      expect(malformed.code).toBe(3)
      expect(malformed.stdout).toBe("")
      expect(malformed.stderr).toContain(
        "response DELIVERED, but the daemon returned malformed committed tracker proof",
      )
      expect(malformed.stderr).toContain("Verify current state with: tribe pending --owner @chief")

      const closes = calls.filter((call) => call.method === "tribe.pending" && call.params.close !== undefined)
      expect(closes).toEqual([])
      expect(calls.filter((call) => call.method === "cli_session_pending_close_v1")).toEqual([
        {
          method: "cli_session_pending_close_v1",
          params: { owner: "@chief", close: "req-123", authority: null },
        },
        {
          method: "cli_session_pending_close_v1",
          params: { owner: "@chief", close: "req-123", authority },
        },
      ])
      expect(calls.filter((call) => call.method === "tribe.send")).toHaveLength(5)
    } finally {
      server.close()
      safeRemoveSync(tmp, { within: TEST_ROOT, allowMissing: true })
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
    expect(prose.stderr).toContain("no daemon-validated launch identity")
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

  // @ag/tribe/21921 originally kept seats from going mute by degrading an
  // unresolvable launch to an anonymous send. That preserved delivery but
  // silently lost the sender — and anonymous actionables cannot participate
  // coherently in the ball graph. The replacement contract is fail-loud by
  // default, with an explicit opt-in for callers that genuinely want an
  // untracked anonymous notification.
  test("an unresolvable launch refuses implicit anonymity and permits explicit anonymous notify", async () => {
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
      const runSend = (extraArgs: string[] = []) =>
        new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveProc) => {
          const child = spawn(BUN_BIN, [CLI, "send", "@agent/7", "still", "reachable", ...extraArgs], {
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

      const refused = await runSend()
      expect(refused).toMatchObject({ code: 1, stdout: "" })
      expect(refused.stderr).toContain("launch-id-with-no-stored-session")
      expect(refused.stderr).toMatch(/not sending/i)
      expect(calls.some((c) => c.method === "tribe.send")).toBe(false)

      calls.length = 0
      const anonymous = await runSend(["--anonymous"])
      expect(anonymous).toMatchObject({ code: 0 })
      expect(anonymous.stdout).toContain("Sent message to @agent/7")
      // Explicit anonymity must not fall back to the env name (21717
      // anti-spoof) or perform a launch lookup whose result is irrelevant.
      expect(calls.some((c) => c.method === "register")).toBe(false)
      expect(calls.some((c) => c.method === "tribe.send")).toBe(true)
      expect(calls.some((c) => c.method === "cli_inbox_status_by_launch_v1")).toBe(false)

      for (const trackedArgs of [
        ["--anonymous", "--reply", "req-123"],
        ["--anonymous", "--request"],
        ["--anonymous", "--incident", "watcher:@agent/7:wedged"],
        ["--anonymous", "--type", "request"],
        ["--anonymous", "--type", "query"],
        ["--anonymous", "--type", "assign"],
      ]) {
        calls.length = 0
        const tracked = await runSend(trackedArgs)
        expect(tracked.code, trackedArgs.join(" ")).toBe(2)
        expect(tracked.stderr).toContain("--anonymous is limited to untracked messages")
        expect(calls, trackedArgs.join(" ")).toEqual([])
      }
    } finally {
      server.close()
      safeRemoveSync(tmp, { within: TEST_ROOT, allowMissing: true })
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
      safeRemoveSync(tmp, { within: TEST_ROOT, allowMissing: true })
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
          const launchId = String(request.params?.launch_id ?? "")
          const result =
            request.method === "cli_inbox_status_by_launch_v1"
              ? {
                  session: launchId.replace(/^launch-/u, ""),
                  launch_id: launchId,
                  launch_parent_pid: process.pid,
                }
              : request.method === "register"
                ? { name: request.params?.name }
                : { sent: true }
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
      const runSend = (sender: string, message: string) =>
        new Promise<{ code: number | null; stderr: string }>((resolveProc) => {
          const child = spawn(BUN_BIN, [CLI, "send", "@reviewer", message, "--type", "notify", "--request", "true"], {
            env: {
              ...process.env,
              TRIBE_SOCKET: socketPath,
              TRIBE_NAME: sender,
              TRIBE_LAUNCH_ID: `launch-${sender}`,
            },
            stdio: ["ignore", "ignore", "pipe"],
          })
          let stderr = ""
          child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")))
          child.on("close", (code) => resolveProc({ code, stderr }))
        })

      expect(await runSend("@sender/1", "first")).toEqual({ code: 0, stderr: "" })
      expect(await runSend("@sender/2", "second")).toEqual({ code: 0, stderr: "" })
      expect(calls.filter((call) => call.method === "tribe.send")).toEqual([
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
      safeRemoveSync(tmp, { within: TEST_ROOT, allowMissing: true })
    }
  })

  test("send refuses TRIBE_NAME as caller-authored identity without explicit anonymity", async () => {
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

      expect(res).toMatchObject({ code: 1, stdout: "" })
      expect(res.stderr).toContain("no daemon-validated launch identity")
      expect(calls).toEqual([])
    } finally {
      server.close()
      safeRemoveSync(tmp, { within: TEST_ROOT, allowMissing: true })
    }
  })
})

/**
 * Bead: @i/5-no-wedged-agents/22990 — the sender is blind to the ball it owes.
 *
 * The check is SHAPE-only: "you owe this recipient and this message is not
 * marked as an answer". It never inspects the message, so it can never decide
 * some text looks like a reply and close a live obligation.
 */
describe("send warns when it should have been a reply (22990)", () => {
  const runAgainstPending = async (
    pendingRows: unknown[],
    args: string[],
    pendingError?: string,
  ): Promise<{ code: number | null; stdout: string; stderr: string }> => {
    const tmp = mkdtempSync(join(tmpdir(), "tribe-wire-send-owed-"))
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
          const request = JSON.parse(line) as { id: number; method: string; params?: Record<string, unknown> }
          let result: unknown
          if (request.method === "tribe.pending") {
            result = {
              content: [
                {
                  text: JSON.stringify(
                    pendingError === undefined
                      ? { owner: "@chief", count: pendingRows.length, pending: pendingRows }
                      : { error: pendingError },
                  ),
                },
              ],
            }
          } else if (request.method === "cli_inbox_status_by_launch_v1") {
            // A send WITHOUT --reply refuses outright unless the daemon
            // validates a launch identity, so the fixture must grant one or
            // every case below exits 1 before reaching the check.
            result = { session: "@chief", launch_id: "launch-22990", launch_parent_pid: 4242 }
          } else if (request.method === "register") {
            result = { name: (request.params?.name as string) ?? "@chief", role: "member" }
          } else if (request.method === "tribe.send") {
            result = { sent: true }
          } else {
            result = { error: "unexpected call " + request.method }
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
      return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveProc) => {
        const child = spawn(BUN_BIN, [CLI, ...args], {
          env: {
            ...process.env,
            TRIBE_SOCKET: socketPath,
            TRIBE_SESSION_NAME: "@chief",
            TRIBE_LAUNCH_ID: "launch-22990",
          },
          stdio: ["ignore", "pipe", "pipe"],
        })
        let stdout = ""
        let stderr = ""
        child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")))
        child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")))
        child.on("close", (code) => resolveProc({ code, stdout, stderr }))
      })
    } finally {
      server.close()
      safeRemoveSync(tmp, { within: TEST_ROOT, allowMissing: true })
    }
  }

  const OWED_TO_AGENT3 = [
    {
      request_id: "req-owed",
      message_id: "msg-owed",
      recipient: "@chief",
      sender: "@agent/3",
      summary: "please rule on the recut",
      status: "active",
    },
  ]

  test("warns with the ball id, its summary and a pasteable closing command — and still sends", async () => {
    const res = await runAgainstPending(OWED_TO_AGENT3, ["send", "@agent/3", "unrelated status"])

    expect(res.code).toBe(0)
    expect(res.stderr).toContain("you hold 1 open ball(s) from @agent/3")
    expect(res.stderr).toContain("req-owed")
    // The reader must see WHICH obligation they are walking past.
    expect(res.stderr).toContain("please rule on the recut")
    // Remediation is a paste, not a lookup.
    expect(res.stderr).toContain("tribe send @agent/3 --type response --reply req-owed")
    // WARN, never refuse.
    expect(res.stderr).toContain("this is a note, not a refusal")
  })

  test("marks an expired ball so the warning distinguishes late from merely open", async () => {
    const res = await runAgainstPending(
      [{ ...OWED_TO_AGENT3[0], status: "expired" }],
      ["send", "@agent/3", "unrelated status"],
    )

    expect(res.code).toBe(0)
    expect(res.stderr).toContain("[EXPIRED]")
  })

  // POSITIVE CONTROLS. Without these the assertions above could pass while the
  // check fired indiscriminately, which would be a warning nobody reads.
  test("POSITIVE CONTROL: silent when the ball is owed to a DIFFERENT seat", async () => {
    const res = await runAgainstPending(OWED_TO_AGENT3, ["send", "@agent/9", "hello"])

    expect(res.code).toBe(0)
    expect(res.stderr).not.toContain("open ball(s) from")
  })

  test("POSITIVE CONTROL: silent when the sender owes nothing", async () => {
    const res = await runAgainstPending([], ["send", "@agent/3", "hello"])

    expect(res.code).toBe(0)
    expect(res.stderr).not.toContain("open ball(s) from")
  })

  test("scoped to balls the SENDER owns — a ball the recipient owes ME does not warn", async () => {
    const res = await runAgainstPending(
      [{ request_id: "req-theirs", recipient: "@agent/3", sender: "@chief", summary: "they owe me", status: "active" }],
      ["send", "@agent/3", "nudge"],
    )

    expect(res.code).toBe(0)
    expect(res.stderr).not.toContain("open ball(s) from")
  })

  test("silent on a broadcast — fan-out would fire on every send once a seat is behind", async () => {
    const res = await runAgainstPending(OWED_TO_AGENT3, ["send", "*", "fleet notice"])

    expect(res.code).toBe(0)
    expect(res.stderr).not.toContain("open ball(s) from")
  })

  test("an unreadable tracker stays quiet rather than crying wolf", async () => {
    const res = await runAgainstPending([], ["send", "@agent/3", "hello"], "tracker unavailable")

    expect(res.code).toBe(0)
    expect(res.stderr).not.toContain("open ball(s) from")
  })
})

describe("a second recipient must never be absorbed into the message body", () => {
  /**
   * `send` takes exactly one `<to>` followed by a variadic `<message...>`, so
   * `tribe send @a @b "text"` silently made `@b` the FIRST WORD OF THE BODY,
   * delivered to `@a` only, printed `Sent message to @a`, and exited 0. The
   * dropped recipient was indistinguishable from success.
   *
   * The MCP surface over the same protocol accepts `to` as an array with
   * `fanout`, so the CLI is strictly narrower — and was silent about it.
   *
   * This refuses rather than adding array support: widening `<to>` is a public
   * API change. Failing loud is a bug fix.
   */
  function runSend(args: string[]): Promise<{ code: number | null; stderr: string }> {
    return new Promise((resolveProcess) => {
      const child = spawn(BUN_BIN, [CLI, ...args], {
        cwd: TEST_ROOT,
        stdio: ["ignore", "pipe", "pipe"],
      })
      let stderr = ""
      child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")))
      child.on("close", (code) => resolveProcess({ code, stderr }))
    })
  }

  test("refuses when the first message word is a bare seat name, naming both recipients", async () => {
    const res = await runSend(["send", "@cto", "@chief", "the", "actual", "message"])

    expect(res.code).toBe(2)
    // Names BOTH, so the reader sees exactly what would have been swallowed.
    expect(res.stderr).toContain("@cto")
    expect(res.stderr).toContain("@chief")
    // Says what would have happened, not merely that something is invalid.
    expect(res.stderr).toMatch(/message body|absorbed|swallow/iu)
  })

  test("does not fire when the message is one quoted argument — the normal correct form", async () => {
    const res = await runSend(["send", "@cto", "@chief please look at this"])

    // May fail later for lack of a daemon; it must NOT fail as a recipient error.
    expect(res.stderr).not.toMatch(/second recipient|absorbed into the message/iu)
  })

  test("does not fire on a single-word message that happens to be a seat name", async () => {
    const res = await runSend(["send", "@cto", "@chief"])

    expect(res.stderr).not.toMatch(/second recipient|absorbed into the message/iu)
  })
})
