import { describe, expect, test } from "vitest"
import { Command } from "@silvery/commander"
import {
  commandDescriptorByMcpName,
  TRIBE_COMMAND_DESCRIPTORS,
  type TribeCommandDescriptor,
  type TribeCliProjection,
} from "../src/command-descriptors.ts"
import { registerReadCommands } from "../src/cli/read.ts"
import { registerSendCommands } from "../src/cli/send.ts"
import { TOOLS_LIST } from "../src/lib/tools-list.ts"

function visibleCliProjection(descriptor: TribeCommandDescriptor): Extract<TribeCliProjection, { kind: "available" }> {
  expect(descriptor.cli?.kind).toBe("available")
  return descriptor.cli as Extract<TribeCliProjection, { kind: "available" }>
}

function hiddenCliProjection(descriptor: TribeCommandDescriptor): Extract<TribeCliProjection, { kind: "hidden" }> {
  expect(descriptor.cli?.kind).toBe("hidden")
  return descriptor.cli as Extract<TribeCliProjection, { kind: "hidden" }>
}

function buildProgram(): Command {
  const program = new Command("tribe-test")
  registerReadCommands(program)
  registerSendCommands(program)
  return program
}

function findCmd(program: Command, name: string): Command | undefined {
  return program.commands.find((cmd) => cmd.name() === name) as Command | undefined
}

function longOptionFlag(flags: string): string | undefined {
  return flags.match(/--[a-z-]+/)?.[0]
}

describe("Tribe command descriptors", () => {
  test("cover every exposed MCP tool, with CLI projection explicit", () => {
    const descriptorMcpNames = new Set(TRIBE_COMMAND_DESCRIPTORS.map((descriptor) => descriptor.mcp.name))

    for (const tool of TOOLS_LIST) {
      expect(descriptorMcpNames.has(tool.name), `missing descriptor for MCP tool ${tool.name}`).toBe(true)
      expect(
        commandDescriptorByMcpName(tool.name)?.cli?.kind,
        `missing CLI projection metadata for ${tool.name}`,
      ).toMatch(/available|hidden/)
    }
  })

  test("project the approved CLI/MCP parity slice from one descriptor", () => {
    const pairs = [
      ["send", "send"],
      ["join", "join"],
      ["pending", "pending"],
      ["repair", "repair"],
      ["inbox.wait", "inbox-wait"],
    ] as const

    for (const [mcpName, cliName] of pairs) {
      const descriptor = commandDescriptorByMcpName(mcpName)
      expect(descriptor, `missing descriptor for ${mcpName}`).toBeDefined()
      const cli = visibleCliProjection(descriptor!)
      expect(cli.name).toBe(cliName)
      expect(cli.mapsToMcp).toBe(mcpName)
      expect(cli.description).toBe(descriptor!.description)
      expect(cli.lifetime).toBe("one-shot")
    }
  })

  test("preserves required args, defaults, enums, and transforms for parity commands", () => {
    const sendDescriptor = commandDescriptorByMcpName("send")!
    const send = visibleCliProjection(sendDescriptor)
    expect(sendDescriptor.mcp.outputSchema.properties?.tracker).toMatchObject({
      type: "object",
      required: ["request_id", "closed"],
    })
    expect(send.arguments?.map((arg) => [arg.name, arg.variadic ?? false])).toEqual([
      ["to", false],
      ["message", true],
    ])
    expect(send.options?.find((option) => option.name === "type")?.enum).toEqual([
      "assign",
      "status",
      "query",
      "response",
      "notify",
      "request",
      "verdict",
    ])
    expect(send.options?.find((option) => option.name === "type")?.default).toBe("notify")
    expect(send.options?.find((option) => option.name === "fanout")?.enum).toEqual(["first", "all"])
    expect(send.options?.find((option) => option.name === "fanout")?.default).toBe("first")
    expect(send.options?.find((option) => option.name === "expires-in-ms")?.mapsTo).toBe("expires_in_ms")
    expect(sendDescriptor.mcp.inputSchema.properties?.expires_in_ms).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 86_400_000,
    })

    const join = visibleCliProjection(commandDescriptorByMcpName("join")!)
    expect(join.arguments?.map((arg) => arg.name)).toEqual(["name"])
    expect(join.options?.find((option) => option.name === "delivery")?.enum).toEqual(["push", "pull"])
    expect(join.options?.find((option) => option.name === "delivery")?.default).toBe("pull")

    const pending = visibleCliProjection(commandDescriptorByMcpName("pending")!)
    expect(pending.options?.find((option) => option.name === "stale")?.mapsTo).toBe("stale_ms")
    expect(pending.options?.find((option) => option.name === "stale")?.transform).toBe("duration-ms")
    expect(pending.options?.find((option) => option.name === "expired")?.flags).toBe("--expired")
    expect(pending.options?.find((option) => option.name === "close")?.requires).toEqual(["owner"])

    const repair = visibleCliProjection(commandDescriptorByMcpName("repair")!)
    expect(repair.options?.find((option) => option.name === "inbox-cursor")?.mapsTo).toBe("inbox_cursor")
    expect(repair.options?.find((option) => option.name === "inbox-cursor")?.enum).toEqual(["tail"])
    expect(repair.options?.find((option) => option.name === "inbox-cursor")?.default).toBeUndefined()
    expect(repair.options?.find((option) => option.name === "reap-stale-transports")?.mapsTo).toBe(
      "reap_stale_transports",
    )
    expect(commandDescriptorByMcpName("repair")?.mcp.inputSchema.oneOf).toEqual([
      { required: ["inbox_cursor"] },
      { required: ["reap_stale_transports"] },
    ])

    const inboxWait = visibleCliProjection(commandDescriptorByMcpName("inbox.wait")!)
    expect(inboxWait.options?.find((option) => option.name === "timeout")?.mapsTo).toBe("timeout_ms")
    expect(inboxWait.options?.find((option) => option.name === "timeout")?.transform).toBe("duration-ms")
    expect(inboxWait.options?.find((option) => option.name === "timeout")?.default).toBe("30s")
    expect(inboxWait.options?.find((option) => option.name === "wake-on-correlated-reply")?.mapsTo).toBe(
      "wake_on_correlated_reply",
    )
    expect(commandDescriptorByMcpName("inbox.wait")?.mcp.inputSchema.properties?.wake_on_correlated_reply).toEqual({
      type: "boolean",
      description: expect.any(String),
    })
    expect(commandDescriptorByMcpName("inbox.wait")?.mcp.outputSchema.properties?.effective_timeout_ms).toEqual({
      type: "number",
      description: expect.any(String),
    })
    expect(commandDescriptorByMcpName("inbox.wait")?.mcp.outputSchema.properties?.attention).toMatchObject({
      type: "object",
    })
  })

  test("matches descriptor-backed CLI projections to the actual Commander program", () => {
    const program = buildProgram()
    const visibleDescriptors = TRIBE_COMMAND_DESCRIPTORS.filter((descriptor) => descriptor.cli.kind === "available")

    for (const descriptor of visibleDescriptors) {
      const cli = visibleCliProjection(descriptor)
      const cmd = findCmd(program, cli.name)
      expect(cmd, `missing Commander command ${cli.name}`).toBeDefined()
      expect(cmd!.description()).toBe(cli.description)

      const actualOptions = new Set(
        (cmd!.options ?? []).map((option: { long?: string }) => option.long).filter(Boolean),
      )
      for (const option of cli.options ?? []) {
        const flag = longOptionFlag(option.flags)
        expect(flag, `missing long flag in descriptor option ${cli.name}.${option.name}`).toBeDefined()
        expect(actualOptions.has(flag!), `Commander command ${cli.name} missing option ${flag}`).toBe(true)
      }

      const actualArgs = (cmd as unknown as { _args?: Array<{ name(): string; variadic?: boolean }> })._args ?? []
      expect(actualArgs.map((arg) => [arg.name(), arg.variadic ?? false])).toEqual(
        (cli.arguments ?? []).map((arg) => [arg.name, arg.variadic ?? false]),
      )
    }
  })

  test("keeps MCP fetch explicitly hidden from CLI so it is not confused with log", () => {
    const fetch = commandDescriptorByMcpName("fetch")
    expect(fetch).toBeDefined()
    expect(fetch!.mcp.outputSchema.properties?.attention).toMatchObject({
      type: "object",
      required: ["actionable_unread", "pending_balls", "pending_balls_summary"],
      properties: {
        actionable_unread: { type: "array" },
        pending_balls: { type: "array" },
        pending_balls_summary: {
          type: "object",
          required: ["total", "oldest_age_ms"],
          properties: {
            total: { type: "number" },
            oldest_age_ms: { type: "number" },
          },
        },
      },
    })
    const cli = hiddenCliProjection(fetch!)
    expect(cli.reason).toMatch(/log/i)
    expect(cli.reason).toMatch(/snapshot/i)
  })

  test("pins semantic actionable ownership without inventing a delivery-ack surface", () => {
    const send = commandDescriptorByMcpName("send")!
    expect(send.mcp.inputSchema.properties?.request).toMatchObject({
      oneOf: expect.arrayContaining([{ type: "boolean" }, { type: "string" }]),
    })
    expect(send.mcp.inputSchema.properties?.delivery).toMatchObject({
      type: "string",
      enum: ["push", "pull"],
    })
    expect(JSON.stringify(send.mcp.inputSchema.properties?.request)).toMatch(/automatically open/i)
    expect(visibleCliProjection(send).options?.find((option) => option.name === "delivery")?.enum).toEqual([
      "push",
      "pull",
    ])

    const pending = commandDescriptorByMcpName("pending")!
    expect(pending.mcp.inputSchema.properties?.all).toMatchObject({ type: "boolean" })
    expect(pending.mcp.inputSchema.properties?.expired).toMatchObject({
      type: "boolean",
      description: expect.stringMatching(/deadline.*passed/i),
    })
    expect(pending.mcp.inputSchema.properties?.prune).toMatchObject({
      type: "boolean",
      description: expect.stringMatching(/stale_ms/i),
    })
    expect(pending.mcp.outputSchema.properties).toMatchObject({
      all: { type: "boolean" },
      owners: { type: "array" },
      owner_count: { type: "number" },
      oldest_age_ms: { type: "number" },
      warning: { type: "string", description: expect.stringMatching(/closed 0|matching.*ball/i) },
    })
    expect(visibleCliProjection(pending).options?.map((option) => option.name)).toEqual(
      expect.arrayContaining(["all", "expired", "json"]),
    )

    const health = commandDescriptorByMcpName("health")!
    expect(health.mcp.outputSchema.properties).toMatchObject({
      pending_balls: { type: "object" },
      issues: { type: "array" },
    })
    const fetch = commandDescriptorByMcpName("fetch")!
    expect(fetch.mcp.outputSchema.properties).not.toHaveProperty("delivery_ack")
    expect(fetch.mcp.outputSchema.properties).not.toHaveProperty("ack_id")
  })
})
