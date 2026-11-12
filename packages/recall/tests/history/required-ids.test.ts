/**
 * Required issue ids (28593): what the question named, what the vault confirms, what the planner may not add, and
 * when round 1 may not short-circuit. Pure functions — the agent-level shapes live in agent.test.ts.
 */

import { describe, test, expect } from "vitest"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeKmVault } from "../helpers/km-vault.ts"
import {
  extractIssueIdCandidates,
  resolveRequiredIssueIds,
  stripUnrequiredIssueIds,
  unmatchedRequiredIdsIn,
} from "../../src/lib/required-ids.ts"
import type { QueryPlan } from "../../src/lib/plan.ts"
import { setRecallLogging } from "../../src/history/recall-shared.ts"

setRecallLogging(false)

function emptyPlan(partial: Partial<QueryPlan> = {}): QueryPlan {
  return {
    keywords: [],
    phrases: [],
    concepts: [],
    paths: [],
    errors: [],
    bead_ids: [],
    time_hint: null,
    ...partial,
  }
}

function withVault(nodes: Parameters<typeof makeKmVault>[1], fn: (db: string) => void): void {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "recall-required-ids-unit-"))
  try {
    fn(makeKmVault(dir, nodes))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("extractIssueIdCandidates", () => {
  test("takes bare and #-prefixed five-digit tokens, once each, in question order", () => {
    expect(extractIssueIdCandidates("27398 then #32289 then 27398 again")).toEqual(["27398", "32289"])
  })

  test("leaves four-digit numbers, decimals and ids glued to other tokens alone", () => {
    expect(extractIssueIdCandidates("mode 1000 at 0.43322 in v1.27398 and hex abc27398")).toEqual([])
  })

  test("reads both ends of an id range", () => {
    expect(extractIssueIdCandidates("32309-32312")).toEqual(["32309", "32312"])
  })
})

describe("resolveRequiredIssueIds", () => {
  test("a five-digit number the vault does not hold is not an issue id", () => {
    withVault(
      [{ id: "27398-mouse-leak", fsPath: "@ag/code/27398-mouse-leak.md", title: "leak", content: "" }],
      (db) => {
        const resolved = resolveRequiredIssueIds("27398 and 10000", db)
        expect(resolved.required).toEqual(["27398"])
        expect(resolved.unconfirmed).toEqual(["10000"])
        expect(resolved.unverified).toBe(false)
      },
    )
  })

  test("names the id required unverified when no vault is bound, rather than dropping it", () => {
    const resolved = resolveRequiredIssueIds("27398 mouse leak", null)
    expect(resolved.required).toEqual(["27398"])
    expect(resolved.unverified).toBe(true)
  })

  test("no id-shaped token means nothing is required and no vault is needed", () => {
    expect(resolveRequiredIssueIds("mouse leak after reattach", null)).toEqual({
      required: [],
      unconfirmed: [],
      unverified: false,
    })
  })
})

describe("stripUnrequiredIssueIds", () => {
  test("drops whole entries that mention an id the question did not name", () => {
    const plan = emptyPlan({
      keywords: ["platform", "task/32309"],
      phrases: ["merge 32310 now"],
      bead_ids: ["32289", "32309", "32312"],
    })
    const stripped = stripUnrequiredIssueIds(plan, ["32289"])
    expect(stripped.plan.keywords).toEqual(["platform"])
    expect(stripped.plan.phrases).toEqual([])
    expect(stripped.plan.bead_ids).toEqual(["32289"])
    expect(stripped.dropped).toEqual(["keywords:32309", "phrases:32310", "bead_ids:32309", "bead_ids:32312"])
  })

  test("filters nothing when the question named no id", () => {
    const plan = emptyPlan({ bead_ids: ["32309", "32312"] })
    const stripped = stripUnrequiredIssueIds(plan, [])
    expect(stripped.plan).toBe(plan)
    expect(stripped.dropped).toEqual([])
  })
})

describe("unmatchedRequiredIdsIn", () => {
  const fanout = (topKeys: string[], hits: Record<string, string[]>) =>
    ({
      results: topKeys.map((key) => {
        const [type, sessionId] = key.split(":") as [string, string]
        return { type, sessionId } as never
      }),
      variantHits: new Map(Object.entries(hits)),
    }) as never

  test("an id whose own variant reached the top results is matched", () => {
    expect(unmatchedRequiredIdsIn(["32289"], fanout(["message:s1"], { "32289": ["message:s1"] }))).toEqual([])
  })

  test("an id that matched only outside the top results is unmatched", () => {
    expect(
      unmatchedRequiredIdsIn(["32289", "27398"], fanout(["message:noise"], { "32289": ["message:distant"] })),
    ).toEqual(["32289", "27398"])
  })
})
