/**
 * @failure L2 Tribe regrows L3 Tent subprocess tools or dead bead-era observers.
 * @level   L3
 * @consumer Standalone Tribe users and the hh composition layer
 */

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"

const packagesRoot = fileURLToPath(new URL("../../../..", import.meta.url))
const tribeRoot = resolve(packagesRoot, "..")

function productionSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name)
    if (entry.isDirectory()) return productionSources(path)
    if (!entry.name.endsWith(".ts") || /\.(?:test|spec)\.ts$/.test(entry.name)) return []
    return [path]
  })
}

describe("package layer and live-surface boundaries", () => {
  test("contains no Tent subprocess vocabulary, compatibility aliases, or retired modules", () => {
    const sources = productionSources(packagesRoot)
    const forbiddenText = [
      /\.agents\/skills\/tent/,
      /\.claude\/skills\/tent/,
      /\bfleet-(?:read|wake|exec)\b/,
      /\.beads\/backup\/issues\.jsonl/,
      /backup\/issues\.jsonl/,
      /\bensureAllDaemonsIfConfigured\b/,
      /\bensureDaemonIfConfigured\b/,
      /\bresolveDaemonScriptPath\b/,
      /\bspawnDaemonDetached\b/,
      /\bexport function parsePlan\(/,
      /\bexport function sanitizeForContext\(/,
      /\bHEALTH_REAPER_\w+/,
      /\bHEALTH_FD_\w+/,
      /\bfdCount\b/,
      /\bcheckReaper\b/,
      /\bReaperExemptEntry\b/,
      /\b(?:clear|is|list|set)ReaperExempt\b/,
      /\breaperExemptMarkerPath\b/,
      /\bresolveReaperExemptDir\b/,
      /health:reaper:/,
      /reaper-exempt/,
    ]
    const textViolations = sources.flatMap((path) => {
      const source = readFileSync(path, "utf8")
      return forbiddenText.some((pattern) => pattern.test(source)) ? [relative(packagesRoot, path)] : []
    })
    const activityContractOwners = sources
      .filter((path) => /\bexport type ActivityKind\b/.test(readFileSync(path, "utf8")))
      .map((path) => relative(packagesRoot, path))
    const mcpJsonDecoderOwners = sources
      .filter((path) => /\bfunction mcpJsonContent\(/.test(readFileSync(path, "utf8")))
      .map((path) => relative(packagesRoot, path))
    const cliDaemonLifecycleOwners = sources
      .filter((path) => /Start one with: bun tribe-daemon/.test(readFileSync(path, "utf8")))
      .map((path) => relative(packagesRoot, path))
    const retiredModules = new Set([
      "daemon/src/lib/activity-watch.ts",
      "daemon/src/lib/bead-snapshot.ts",
      "daemon/src/lib/beads-plugin.ts",
      "daemon/src/lib/compose/with-plugin-api.ts",
      "daemon/src/lib/compose/with-plugin.ts",
      "daemon/src/lib/dolt-reaper-plugin.ts",
      "daemon/src/lib/health-monitor-canonical-reaper.ts",
      "daemon/src/lib/pending-ball-deadlines.ts",
      "daemon/src/lib/retro.ts",
      "recall/src/history/index.ts",
      "recall/src/lib/summarize.ts",
      "wire/src/reaper-exempt.ts",
    ])
    const moduleViolations = sources
      .map((path) => relative(packagesRoot, path))
      .filter((path) => retiredModules.has(path))
    const retiredPaths = ["packages/bg-recall", "plugins/claude/recall/lib/timers.ts"]
    const retiredPathViolations = retiredPaths.filter((path) => existsSync(resolve(tribeRoot, path)))

    expect({
      activityContractOwners,
      cliDaemonLifecycleOwners,
      mcpJsonDecoderOwners,
      moduleViolations,
      retiredPathViolations,
      textViolations,
    }).toEqual({
      activityContractOwners: ["wire/src/activity-log-contract.ts"],
      cliDaemonLifecycleOwners: ["wire/src/cli/daemon-client.ts"],
      mcpJsonDecoderOwners: ["wire/src/cli/mcp-json-content.ts"],
      moduleViolations: [],
      retiredPathViolations: [],
      textViolations: [],
    })
  })
})
