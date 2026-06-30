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
import { buildSendPayload, registerSendCommands } from "../src/cli/send.ts"

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
})
