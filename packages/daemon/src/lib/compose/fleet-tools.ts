/**
 * fleetTools() — MCP/registry tools for fleet.read / fleet.wake / fleet.exec (21743).
 *
 * Wraps the stable tent CLI core (`bun tent fleet-* --json`) so tribe MCP
 * surfaces the same typed rows as `flt read|wake|exec` without a second
 * classifier. Shell-out keeps tribe free of tent imports (vendor independence).
 *
 * Registration is optional at daemon boot when a project root is known; tools
 * fail loud if tent cannot be reached (no silent empty fleet).
 */

import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import type { Tool, ToolContext } from "tribe-wire"

export const FLEET_TOOL_NAMES = ["fleet.read", "fleet.wake", "fleet.exec"] as const

export interface FleetToolsOpts {
  /** hh / km project root that contains tent scripts + package.json. */
  readonly projectRoot: string
  /** Override runner for tests. */
  readonly run?: (
    tentArgs: readonly string[],
  ) => { status: number; stdout: string; stderr: string }
}

function defaultRun(
  projectRoot: string,
  tentArgs: readonly string[],
): { status: number; stdout: string; stderr: string } {
  const tentTs = join(projectRoot, ".claude/skills/tent/scripts/tent.ts")
  const entry = existsSync(tentTs) ? tentTs : join(projectRoot, ".agents/skills/tent/scripts/tent.ts")
  if (!existsSync(entry)) {
    return {
      status: 1,
      stdout: "",
      stderr: `fleet tools: tent entry missing under ${projectRoot} (looked for .claude and .agents skills/tent/scripts/tent.ts)`,
    }
  }
  const r = spawnSync("bun", [entry, ...tentArgs], {
    cwd: projectRoot,
    encoding: "utf-8",
    timeout: 120_000,
    env: process.env,
  })
  return {
    status: r.status ?? 1,
    stdout: (r.stdout ?? "").trim(),
    stderr: (r.stderr ?? "").trim(),
  }
}

function parseJsonOrThrow(stdout: string, stderr: string, status: number, label: string): unknown {
  if (status !== 0 && !stdout) {
    throw new Error(`${label} failed (exit ${status}): ${stderr || "no output"}`)
  }
  try {
    return JSON.parse(stdout)
  } catch {
    throw new Error(
      `${label}: expected JSON from tent CLI (exit ${status}); stderr=${stderr.slice(0, 200)} stdout=${stdout.slice(0, 200)}`,
    )
  }
}

/** Protocol-agnostic ToolDefs for the fleet family. */
export function fleetTools(opts: FleetToolsOpts): Tool[] {
  const run = opts.run ?? ((args) => defaultRun(opts.projectRoot, args))

  const read: Tool = {
    name: "fleet.read",
    description:
      "Classify every agent pane via classifySeat. Same rows as `tent fleet-read --json` / `flt read --json`.",
    schema: {
      type: "object",
      properties: {
        seats: { type: "string", description: "all | @a,@b | role:worker" },
      },
    },
    handler: async (args: Record<string, unknown>, _ctx: ToolContext) => {
      void _ctx
      // tent fleet-read has no seats filter CLI yet; full report then optional filter client-side
      const r = run(["fleet-read", "--json"])
      const report = parseJsonOrThrow(r.stdout, r.stderr, r.status, "fleet.read") as {
        seats?: Array<{ seat: string }>
        [k: string]: unknown
      }
      const seats = typeof args.seats === "string" ? args.seats.trim() : ""
      if (!seats || seats === "all") return report
      if (seats === "role:worker" || seats === "role:workers") {
        return {
          ...report,
          seats: (report.seats ?? []).filter((s) => /^@dev\/\d+$/.test(s.seat)),
        }
      }
      const want = new Set(seats.split(",").map((s) => s.trim()).filter(Boolean))
      return { ...report, seats: (report.seats ?? []).filter((s) => want.has(s.seat)) }
    },
  }

  const wake: Tool = {
    name: "fleet.wake",
    description: "Draft-safe auto-wake plan/apply over classifySeat. Same as `tent fleet-wake`.",
    schema: {
      type: "object",
      properties: {
        apply: { type: "boolean" },
        notify: { type: "boolean" },
        protect: { type: "string" },
      },
    },
    handler: async (args: Record<string, unknown>) => {
      const argv = ["fleet-wake", "--json"]
      if (args.apply) argv.push("--apply")
      if (args.notify) argv.push("--notify")
      if (typeof args.protect === "string" && args.protect.trim()) {
        argv.push("--protect", args.protect.trim())
      }
      const r = run(argv)
      return parseJsonOrThrow(r.stdout, r.stderr, r.status, "fleet.wake")
    },
  }

  const exec: Tool = {
    name: "fleet.exec",
    description:
      "Parallel dsh: send one command to selected seats. Typed per-seat rows; missing panes are unreachable.",
    schema: {
      type: "object",
      properties: {
        seats: { type: "string" },
        command: { type: "string" },
        dryRun: { type: "boolean" },
      },
      required: ["command"],
    },
    handler: async (args: Record<string, unknown>) => {
      const command = typeof args.command === "string" ? args.command.trim() : ""
      if (!command) throw new Error("fleet.exec requires non-empty command")
      const argv = ["fleet-exec", "--json"]
      if (typeof args.seats === "string" && args.seats.trim()) {
        argv.push("--seats", args.seats.trim())
      }
      if (args.dryRun) argv.push("--dry-run")
      argv.push("--", command)
      const r = run(argv)
      // fleet-exec exits 1 on unreachable seats; still parse JSON if present
      if (r.stdout.trim().startsWith("{") || r.stdout.trim().startsWith("[")) {
        return parseJsonOrThrow(r.stdout, r.stderr, 0, "fleet.exec")
      }
      return parseJsonOrThrow(r.stdout, r.stderr, r.status, "fleet.exec")
    },
  }

  return [read, wake, exec]
}
