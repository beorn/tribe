/**
 * required-ids.ts — the issue ids the question itself names.
 *
 * Recall's failure 28593 is a planner that answers about the wrong issues. Two measured shapes: the user names
 * `27398` and the planner substitutes 28503/28586 and drops it; or the user names `32289` and the planner keeps it
 * yet also pulls 32309/32310/32312 out of context, so round 1 short-circuits on generic coverage (10/24 = 0.42) and
 * never has to match the id at all. Three rules follow from the acceptance recorded there:
 *
 *   1. An issue id in the question is a REQUIRED match, resolved by vault id first — so a five-digit number that
 *      names no issue is not silently promoted to one.
 *   2. The planner may not inject issue ids the question did not name.
 *   3. The round-1 short-circuit may not fire while a required id is unmatched.
 *
 * Everything here is deterministic: no model output decides what the question named.
 */

import { log } from "../history/recall-shared.ts"
import { openVaultDb } from "../history/vault-fts.ts"
import type { FanoutResult } from "./fanout.ts"
import { PLAN_BUCKET_KEYS, type QueryPlan } from "./plan.ts"

/**
 * Five digits, at a word boundary, optionally `#`-prefixed.
 *
 * Four-digit tokens are left alone (a year, a mouse mode 1000) and so is anything glued to a word character, which
 * is what keeps hex ids and version strings out. The id shape alone never promotes a number to a required id: the
 * vault lookup below decides that, which is what the acceptance means by "vault id lookup first".
 */
const ISSUE_ID_PATTERN = /(?<![\w.])(#?)(\d{5})(?![\w])/g

export interface RequiredIdResolution {
  /** Ids the question names that the vault holds — the required matches. */
  required: string[]
  /** Five-digit tokens the vault does not hold: numbers, not issues. */
  unconfirmed: string[]
  /** True when no vault was bound, so `required` holds unconfirmed candidates rather than verified ids. */
  unverified: boolean
}

/** Every distinct five-digit token in the question, in the order the question names them. */
export function extractIssueIdCandidates(query: string): string[] {
  const ids: string[] = []
  for (const match of query.matchAll(ISSUE_ID_PATTERN)) {
    const id = match[2]!
    if (!ids.includes(id)) ids.push(id)
  }
  return ids
}

/**
 * The question's issue ids, resolved against the vault's node names first.
 *
 * An unbound vault does not switch rule 1 off: the digits stay required and the log says they were taken unverified,
 * because dropping them would re-open 28593 exactly where nobody could see why.
 */
export function resolveRequiredIssueIds(query: string, vaultDb: string | null): RequiredIdResolution {
  const candidates = extractIssueIdCandidates(query)
  if (candidates.length === 0) return { required: [], unconfirmed: [], unverified: false }

  if (vaultDb === null) {
    log(
      `required-ids: no vault bound, so [${candidates.join(", ")}] is required unverified — the id lookup could not run`,
    )
    return { required: candidates, unconfirmed: [], unverified: true }
  }

  const db = openVaultDb(vaultDb)
  const lookup = db.prepare("SELECT 1 AS hit FROM nodes WHERE name LIKE ?1 OR fs_path LIKE ?2 LIMIT 1")
  const required: string[] = []
  const unconfirmed: string[] = []
  for (const id of candidates) {
    const hit = lookup.get(`${id}-%`, `%/${id}-%`)
    if (hit) required.push(id)
    else unconfirmed.push(id)
  }
  log(
    `required-ids: required [${required.join(", ")}]${unconfirmed.length > 0 ? `, not issue ids [${unconfirmed.join(", ")}]` : ""} (${vaultDb})`,
  )
  return { required, unconfirmed, unverified: false }
}

export interface IssueIdStrip {
  plan: QueryPlan
  /** `bucket:id` for every entry the planner injected that the question did not name. */
  dropped: string[]
}

/**
 * Rule 2: once the question names an id, the planner may not add issue ids of its own — the 32289 shape, where
 * three sibling ids the user never mentioned arrived from context and diluted coverage.
 *
 * An entry that mentions a foreign id is dropped whole rather than rewritten: a phrase like "merge task/32309"
 * exists only because of that id. When the question names no id, nothing is filtered — context-mined ids are then
 * the planner's own legitimate signal.
 */
export function stripUnrequiredIssueIds(plan: QueryPlan, requiredIds: string[]): IssueIdStrip {
  if (requiredIds.length === 0) return { plan, dropped: [] }
  const required = new Set(requiredIds)
  const dropped: string[] = []
  const next: QueryPlan = { ...plan }

  for (const key of PLAN_BUCKET_KEYS) {
    const kept: string[] = []
    let droppedHere = false
    for (const value of plan[key]) {
      const foreign = extractIssueIdCandidates(value).filter((id) => !required.has(id))
      if (foreign.length === 0) kept.push(value)
      else {
        droppedHere = true
        for (const id of foreign) dropped.push(`${key}:${id}`)
      }
    }
    if (droppedHere) next[key] = kept
  }

  return { plan: dropped.length > 0 ? next : plan, dropped }
}

/**
 * Rule 3's input: the required ids round 1 did not carry into the results it would answer from.
 *
 * Matching is per variant against the ranked top results, not against the corpus. An id whose own variant matched
 * some distant doc still counts as unmatched — in the 32289 run the noise was prominent and the id was not, and the
 * answer the caller reads is built from the top results.
 */
export function unmatchedRequiredIdsIn(
  requiredIds: string[],
  fanout: Pick<FanoutResult, "results" | "variantHits">,
): string[] {
  if (requiredIds.length === 0) return []
  const top = new Set(fanout.results.map((result) => `${result.type}:${result.sessionId}`))
  return requiredIds.filter((id) => {
    const keys = fanout.variantHits.get(id) ?? []
    return !keys.some((key) => top.has(key))
  })
}
