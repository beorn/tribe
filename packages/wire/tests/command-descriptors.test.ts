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
    const send = visibleCliProjection(commandDescriptorByMcpName("send")!)
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

    const join = visibleCliProjection(commandDescriptorByMcpName("join")!)
    expect(join.arguments?.map((arg) => arg.name)).toEqual(["name"])
    expect(join.options?.find((option) => option.name === "delivery")?.enum).toEqual(["push", "pull"])
    expect(join.options?.find((option) => option.name === "delivery")?.default).toBe("pull")

    const pending = visibleCliProjection(commandDescriptorByMcpName("pending")!)
    expect(pending.options?.find((option) => option.name === "stale")?.mapsTo).toBe("stale_ms")
    expect(pending.options?.find((option) => option.name === "stale")?.transform).toBe("duration-ms")
    expect(pending.options?.find((option) => option.name === "close")?.requires).toEqual(["owner"])

    const repair = visibleCliProjection(commandDescriptorByMcpName("repair")!)
    expect(repair.options?.find((option) => option.name === "inbox-cursor")?.mapsTo).toBe("inbox_cursor")
    expect(repair.options?.find((option) => option.name === "inbox-cursor")?.enum).toEqual(["tail"])
    expect(repair.options?.find((option) => option.name === "inbox-cursor")?.default).toBe("tail")

    const inboxWait = visibleCliProjection(commandDescriptorByMcpName("inbox.wait")!)
    expect(inboxWait.options?.find((option) => option.name === "timeout")?.mapsTo).toBe("timeout_ms")
    expect(inboxWait.options?.find((option) => option.name === "timeout")?.transform).toBe("duration-ms")
    expect(inboxWait.options?.find((option) => option.name === "timeout")?.default).toBe("30s")
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

  test("CLI fetch is the timeout-0 drain alias riding inbox.wait, not MCP-fetch parity (20843 S2)", () => {
    const fetch = commandDescriptorByMcpName("fetch")
    expect(fetch).toBeDefined()
    const cli = visibleCliProjection(fetch!)
    expect(cli.name).toBe("fetch")
    expect(cli.description).toMatch(/timeout-0/i)
    expect(cli.mapsToMcp).toBe("inbox.wait")
  })
})
