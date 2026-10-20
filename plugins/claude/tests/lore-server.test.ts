/**
 * @failure The provider-owned Claude recall bridge can autostart a detached
 *          Tribe daemon and escape the declared singleton's lifecycle owner.
 * @level   l0
 * @consumer @ag/tribe/22322-daemon-restart-drops-bridges-with-no-repair-verb
 *
 * Also pins the standalone marketplace install path and host boundary. The
 * pre-cutover placeholder pointed at bearly's @bearly/tribe; that era ended
 * with the 19273 move.
 *
 * @source-grep the recall-bridge boundary — `recall/server.ts` and its socket
 *   helper are connect-only (no `ensureTribeDaemonIfConfigured`, no autostart)
 *   and the README names the standalone marketplace install path — is read from
 *   those files' text.
 */

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, test } from "vitest"
import { toAskResult, toPlanOnlyResult } from "../recall/lib/rpc.ts"
import type { PlanCall } from "../../../packages/recall/src/lib/plan.ts"
import type { AgentRecallResult } from "../../../packages/recall/src/lib/agent.ts"

const RECALL_SERVER = readFileSync(resolve(import.meta.dirname, "../recall/server.ts"), "utf8")
const RECALL_SOCKET = readFileSync(resolve(import.meta.dirname, "../recall/lib/socket.ts"), "utf8")

describe("Claude plugin boundary", () => {
  test.each([true, false])("planner wire receipts survive success=%s", (success) => {
    const call: PlanCall = {
      plan: success
        ? {
            keywords: ["fixture"],
            phrases: [],
            concepts: [],
            paths: [],
            errors: [],
            bead_ids: [],
            time_hint: null,
            notes: "",
          }
        : null,
      elapsedMs: 1,
      cost_usd: 0.125,
      list_equivalent_reason: "missing usage for first attempt",
      list_equivalent_basis: [],
      calls: [
        {
          model: { provider: "fixture", modelId: "fixture" },
          cost_usd: 0.125,
          usage: { promptTokens: 1, completionTokens: 1, raw: { invoice: "first" } },
        },
      ],
      ...(success ? {} : { error: "paid parse failure" }),
    }
    const wire = toPlanOnlyResult(call, success ? ["fixture"] : undefined)
    expect(wire).toMatchObject({
      ok: success,
      cost_usd: 0.125,
      calls: call.calls,
      list_equivalent_reason: "missing usage for first attempt",
    })
    expect(wire).not.toHaveProperty("cost")
    expect(wire.list_equivalent_usd).toBeUndefined()
    if (!success) expect(wire.error).toBe("paid parse failure")
  })

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
      cost_usd: 0,
      list_equivalent_usd: 0.25,
      list_equivalent_basis: [{ rateSource: "sku", matchedModelId: "fixture-model" }],
      calls: [
        {
          model: { provider: "fixture", modelId: "fixture-model" },
          cost_usd: 0,
          usage: { promptTokens: 10, completionTokens: 5, raw: { invoice: "original" } },
        },
      ],
      trace: {
        rounds: [],
        decision: { round2Mode: "off", reason: "fixture" },
        contextChars: 0,
        synthPath: "none",
        synthCallsUsed: 0,
      },
    }
    const noMatches = toAskResult(base)
    expect(noMatches).toMatchObject({
      cost_usd: 0,
      list_equivalent_usd: 0.25,
      list_equivalent_basis: [{ matchedModelId: "fixture-model" }],
      calls: base.calls,
    })
    expect(noMatches).not.toHaveProperty("cost")

    const degraded = toAskResult({
      ...base,
      provenance: "stale",
      cost_usd: undefined,
      cost_usd_reason: "charge unavailable for unfinished loser",
      list_equivalent_usd: undefined,
      list_equivalent_reason: "usage unavailable for unfinished loser",
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
      cost_usd_reason: "charge unavailable for unfinished loser",
      list_equivalent_reason: "usage unavailable for unfinished loser",
      calls: base.calls,
      answer: null,
      provenance: "stale",
      results: [{ sessionId: "session-1", snippet: "The lexical hit remains useful." }],
      synthesisFailure: {
        summary: "No LLM provider is available; rerun with --raw.",
        excludedProviders: [{ provider: "openai", reason: "account unavailable" }],
      },
    })
    expect(degraded.cost_usd).toBeUndefined()
    expect(degraded.list_equivalent_usd).toBeUndefined()
    expect(degraded).not.toHaveProperty("cost")
  })
})
