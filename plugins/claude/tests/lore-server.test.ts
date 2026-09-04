/**
 * @failure The provider-owned Claude recall bridge can autostart a detached
 *          Tribe daemon and escape the declared singleton's lifecycle owner.
 * @level   l0
 * @consumer @ag/tribe/22322-daemon-restart-drops-bridges-with-no-repair-verb
 *
 * Also pins the standalone marketplace install path and host boundary. The
 * pre-cutover placeholder pointed at bearly's @bearly/tribe; that era ended
 * with the 19273 move.
 */

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, test } from "vitest"
import { toAskResult } from "../recall/lib/rpc.ts"
import type { AgentRecallResult } from "../../../packages/recall/src/lib/agent.ts"

const RECALL_SERVER = readFileSync(resolve(import.meta.dirname, "../recall/server.ts"), "utf8")
const RECALL_SOCKET = readFileSync(resolve(import.meta.dirname, "../recall/lib/socket.ts"), "utf8")

describe("Claude plugin boundary", () => {
  test("keeps the provider-owned recall bridge connect-only", () => {
    expect(RECALL_SERVER).not.toContain("ensureTribeDaemonIfConfigured")
    expect(RECALL_SERVER).not.toContain("autostartChecked")
    expect(RECALL_SOCKET).toMatch(/noSpawn:\s*opts\.noSpawn/u)
  })

  test("documents the standalone marketplace install and Tribe boundary", () => {
    const readme = readFileSync(resolve(import.meta.dirname, "../README.md"), "utf8")

    expect(readme).toContain("/plugin marketplace add beorn/tribe")
    expect(readme).toContain("/plugin install tribe@tribe")
    expect(readme).toContain("Reusable protocol code belongs in `tribe-wire`")
    expect(readme).toContain("Project workflow conventions")
    expect(readme).not.toContain("Placeholder")
  })

  test("preserves the degraded reason and provenance in the ask payload", () => {
    const base: AgentRecallResult = {
      query: "provider health",
      provenance: "complete",
      synthesis: null,
      results: [],
      durationMs: 42,
      trace: {
        rounds: [],
        decision: { round2Mode: "off", reason: "fixture" },
        contextChars: 0,
        synthPath: "none",
        synthCallsUsed: 0,
      },
    }
    const noMatches = toAskResult(base)

    const degraded = toAskResult({
      ...base,
      provenance: "stale",
      results: [
        {
          type: "message",
          sessionId: "session-1",
          sessionTitle: "Provider notes",
          timestamp: 1,
          snippet: "The lexical hit remains useful.",
          rank: -1,
        },
      ],
      synthesisFailure: {
        summary: "No LLM provider is available; rerun with --raw.",
        totalBudgetMs: 20_000,
        attempts: [],
        batches: [],
        excludedProviders: [{ provider: "openai", modelId: "gpt-5-nano", reason: "account unavailable" }],
        consideredProviders: [],
      },
    })

    expect(noMatches).toMatchObject({ answer: null, provenance: "complete", results: [] })
    expect(noMatches).not.toHaveProperty("synthesisFailure")
    expect(degraded).toMatchObject({
      answer: null,
      provenance: "stale",
      results: [{ sessionId: "session-1", snippet: "The lexical hit remains useful." }],
      synthesisFailure: {
        summary: "No LLM provider is available; rerun with --raw.",
        excludedProviders: [{ provider: "openai", reason: "account unavailable" }],
      },
    })
  })
})
