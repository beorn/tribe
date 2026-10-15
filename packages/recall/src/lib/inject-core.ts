/**
 * Shared recall-and-format pipeline used by both injection paths:
 *   1. Lore daemon's `tribe.inject_delta` (in-memory Map-backed SeenStore)
 *   2. Library `hookRecall` fallback (tmpfile-backed SeenStore)
 *
 * Both paths filter trivial prompts, run an FTS recall, dedup already-shown
 * results against a per-session seen set, format snippets, and return a
 * discriminated result. The only moving part between them is WHERE the
 * seen set lives — pluggable via the `SeenStore` interface.
 *
 * **Envelope framing** is owned by `tribe-injection-envelope` — the single
 * chokepoint for injection defense. Both recall paths build `InjectedItem`s and
 * call `wrapInjectedContext()`, so the `<injected_context>` envelope, its
 * directive attributes, the `<item>` framing, the imperative rewrite and the
 * protocol footer all come from one implementation shared with every other
 * emitter. See `@km/bearly/14871-memory-tag-collapse` and 28904.
 */

import { readFileSync, writeFileSync } from "node:fs"
import {
  classifyPromptSkip,
  cleanSnippet,
  containsRejectedSignal,
  hasSalience,
  LONG_PROMPT_BYPASS_LENGTH,
  MAX_RECALL_QUERY_CHARS,
  MIN_RANK_THRESHOLD,
  stripHarnessEnvelopes,
  type InjectSkipReason,
} from "./prompt-filter.ts"
import { mergeRecallResults, recall } from "../history/search.ts"
import type { RecallOptions, RecallPhase, RecallResult } from "../history/recall-shared.ts"
import { deriveVaultAnchor } from "../history/vault-glossary.ts"
import type { VaultQuery } from "../history/vault-fts.ts"
import { RecallDeadlineError } from "./recall-deadline.ts"
import { RECALL_WALL_MS } from "../history/recall-budget.ts"
// Envelope framing primitives live in the shared library. Re-exported here so
// existing callers (and the plugin's own tests) keep working without churn.
// Relative import because plugins/ is not a declared workspace inside bearly
// itself — cross-plugin imports follow the same convention as recall →
// llm/tribe (see plan.ts, hooks.ts).
import {
  CONTEXT_PROTOCOL_FOOTER as ENVELOPE_FOOTER,
  rewriteImperativeAsReported as envelopeRewriteImperative,
  wrapInjectedContext,
  type InjectedItem,
} from "../../../injection-envelope/src/index.ts"
import { emitInjectionDebugEvent } from "../../../injection-envelope/src/debug.ts"

/** Re-export the canonical footer from the envelope library. */
export const CONTEXT_PROTOCOL_FOOTER = ENVELOPE_FOOTER

/** Re-export the canonical imperative rewrite from the envelope library. */
export const rewriteImperativeAsReported = envelopeRewriteImperative

/**
 * Imperative verbs that signal the prompt is a command, not a question.
 * Prompts starting with one of these mention project terms in passing
 * ("re-open the bead", "broadcast to the tribe") but aren't asking the
 * agent to recall about that term — they're directing action.
 */
const DIRECTIVE_VERBS = new Set([
  "fix",
  "fixes",
  "fixed",
  "create",
  "make",
  "build",
  "add",
  "remove",
  "delete",
  "broadcast",
  "send",
  "post",
  "consider",
  "include",
  "exclude",
  "re-open",
  "reopen",
  "close",
  "pause",
  "stop",
  "go",
  "run",
  "execute",
  "retry",
  "verify",
  "ensure",
  // Note: "do", "wait", "open", "check", "i" intentionally excluded —
  // they often preface technical questions ("do you think...", "wait,
  // what about...", "check if...", "i think we should..."). The
  // false_emit cost is lower than the false_skip cost we observed when
  // those words gated technical-content prompts.
])

/**
 * Detect directive-shape prompts by inspecting the leading verb.
 * Conservative: only triggers on a small allowlist of imperatives, so
 * legitimate questions ("how do I X?") with a leading "i" still pass —
 * caller must combine this with question-shape detection if it cares.
 */
export function looksLikeDirective(prompt: string): boolean {
  const trimmed = prompt.trim().toLowerCase()
  // Question marks anywhere = treat as question, not directive.
  if (trimmed.includes("?")) return false
  // First word check.
  const firstWord = trimmed.split(/[^a-z'-]+/)[0] ?? ""
  return DIRECTIVE_VERBS.has(firstWord)
}

/**
 * Abstract seen-set backing store. Implementations must be cheap per-call —
 * `get/set/size` land on the hot path of every UserPromptSubmit.
 */
export interface SeenStore {
  /** Current turn counter for this session. 0 before first call. */
  turn(): number
  /** Advance and return the new turn number. */
  advanceTurn(): number
  /** Last turn at which `key` was marked seen, or undefined. */
  get(key: string): number | undefined
  /** Mark `key` as seen at `turn`. */
  set(key: string, turn: number): void
  /** Current number of keys tracked. */
  size(): number
  /** Drop entries older than `minTurn`. Called opportunistically. */
  gc(minTurn: number): void
  /** Persist any pending state. No-op for in-memory stores. */
  flush?(): void
}

export interface RunInjectDeltaOptions {
  /**
   * Filled with each step's wall time in ms, keyed by step name (@ag/tribe/25071 row 1). The caller owns the
   * record, so a step that throws is still recorded when the caller logs the failure.
   */
  steps?: Record<string, number>
  /**
   * Max snippets to include. Default 1.
   *
   * V2 lowered this from 3 → 1: dogfooding showed multi-snippet emits dilute
   * the hit rate (one strong hit + two weak hits drags the perceived signal
   * below "useful"). One tight emit beats three loose ones.
   */
  limit?: number
  /**
   * Number of turns a key stays in the seen set. Default 100.
   *
   * V2 raised this from 10 → 100: the same chunk re-injected within a session
   * is by construction redundant. 100 turns ≈ "never re-inject in a normal
   * session" without being literally infinite (gc still works).
   */
  ttlTurns?: number
  /** Min length after cleaning to include a snippet. Default 20. */
  minSnippetLength?: number
  /** Chars per snippet. Default 300. */
  snippetChars?: number
  /**
   * Minimum FTS5 BM25 rank to consider. Ranks are negative; closer to 0 =
   * weaker match. Default `MIN_RANK_THRESHOLD` (-3) drops marginal hits.
   * Override for callers that want to see all results (e.g., debug tools).
   */
  minRank?: number
  /**
   * The vault every recall call of this injection searches, or null when none is bound: the caller resolves its
   * `--vault-db` at its boundary. The unbound notice reads this, the option on the call, so a Worker the binding
   * never reached can no longer search nothing silently (@cto 456e6e77).
   */
  vaultDb: string | null
  /** Test seam for isolating recall/project-source dependencies. */
  deps?: {
    recall?: typeof recall
    ensureProjectSourcesIndexed?: unknown
    deriveVaultAnchor?: typeof deriveVaultAnchor
  }
}

/**
 * Subset of `InjectSkipReason` that represents a prompt we confidently
 * classify as requiring no context injection at all (single-word acks, slash
 * commands, empty prompts). Non-trivial substantive prompts always get at
 * least the protocol footer, even when recall finds no new snippets — the
 * footer reinforces the injection-framing protocol on every turn, independent
 * of whether recall contributed content.
 */
const TRIVIAL_SKIP_REASONS: ReadonlySet<InjectSkipReason> = new Set<InjectSkipReason>([
  "empty",
  "short",
  "trivial",
  "slash_command",
])

/** Outcome of a single injection attempt — pure data, no side effects. */
export type RunInjectDeltaResult =
  | {
      skipped: true
      reason: InjectSkipReason
      /**
       * Each step skipped rather than waited on, and why (@ag/tribe/25071): today the project-source refresh, when
       * the index writer or SQLite's write lock is held. Absent when nothing was skipped.
       */
      skippedSteps?: Record<string, string>
    }
  | {
      skipped: false
      /**
       * Each step skipped rather than waited on, and why (@ag/tribe/25071): today the project-source refresh, when
       * the index writer or SQLite's write lock is held. Absent when nothing was skipped.
       */
      skippedSteps?: Record<string, string>
      additionalContext: string
      newKeys: string[]
      turn: number
      /** True when only the protocol footer was emitted (no fresh recall snippets). */
      footerOnly?: boolean
      /** How call A searched the vault: the form that ran, its terms, the terms no node holds (29487). */
      vaultQuery?: VaultQuery
      /**
       * Set when the recall had nothing to inject: the context is one line naming what was searched and how long it
       * took (@ag/recall/three-dark-search-paths Phase 3).
       */
      emptyRecallReason?: Extract<InjectSkipReason, "no_results" | "all_seen" | "low_quality">
      /** With emptyRecallReason: what was searched and how long each call took, for the hook's own row (29480). */
      searched?: string
    }

/** What an injection says, once per session, when no vault is bound (25149, @cto Q1). */
export const VAULT_UNBOUND_NOTICE = "recall: vault: not bound (pass --vault-db); vault notes were not searched"

/**
 * Seen-store key for {@link VAULT_UNBOUND_NOTICE}. Stored at the largest safe
 * turn, so the store's gc never drops it and the session is told once.
 */
const VAULT_UNBOUND_NOTICE_KEY = "recall:vault-unbound-notice"

/**
 * The vault-unbound notice, framed as an item so {@link wrapInjectedContext}
 * owns the `<injected_context>` envelope and the protocol footer for recall
 * exactly as it does for every other emitter (@km/bearly/14871).
 */
function vaultNoticeItem(): InjectedItem {
  return { title: "vault notice", snippet: VAULT_UNBOUND_NOTICE, type: "notice" }
}

/** One line recall says about its own search, framed like the vault notice (25149). */
function recallNoticeItem(line: string): InjectedItem {
  return { title: "recall notice", snippet: line, type: "notice" }
}

/**
 * The prompt hook's two recall calls on one deadline Worker (@ag/recall/three-dark-search-paths Phase 3, @cto
 * 7f55e4f2): call A searches the vault on the anchor, call B the rest on the prompt. A finishes in milliseconds, so
 * when B runs over the wall A's answer is still injected.
 */
const VAULT_PHASES: readonly RecallPhase[] = ["vault"]
const PROMPT_PHASES: readonly RecallPhase[] = ["messages", "titles"]
const PROMPT_PHASES_SAID = "messages and titles"
/** How many results the hook asks each call for, and keeps after joining them. */
const HOOK_RECALL_LIMIT = 5

/**
 * Adds `run`'s wall time to `steps[name]`, and records it even when `run` throws (@ag/tribe/25071 row 1). The sum is
 * kept raw, so steps under a millisecond still add up; {@link roundSteps} rounds it for a log row.
 */
export function timeStep<T>(steps: Record<string, number> | undefined, name: string, run: () => T): T {
  const start = performance.now()
  try {
    return run()
  } finally {
    if (steps) steps[name] = (steps[name] ?? 0) + performance.now() - start
  }
}

/** A copy of `steps` with each duration rounded to whole milliseconds, for a log row. */
export function roundSteps(steps: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(steps).map(([name, ms]) => [name, Math.round(ms)]))
}

/** {@link timeStep} for a step that returns a promise: the time runs until it settles. */
export async function timeStepAsync<T>(
  steps: Record<string, number> | undefined,
  name: string,
  run: () => Promise<T>,
): Promise<T> {
  const start = performance.now()
  try {
    return await run()
  } finally {
    if (steps) steps[name] = (steps[name] ?? 0) + performance.now() - start
  }
}

/**
 * Run the recall + dedup + format pipeline against the supplied seen-store.
 * Pure logic aside from the recall call itself and the store reads/writes;
 * both callers (daemon, hook library) adapt this to their result shape.
 *
 * With no vault bound, the first injection of a session carries
 * {@link VAULT_UNBOUND_NOTICE} inside the envelope: silent "no vault hits" is
 * the failure to avoid.
 */
export async function runInjectDelta(
  rawPrompt: string,
  store: SeenStore,
  opts: RunInjectDeltaOptions,
): Promise<RunInjectDeltaResult> {
  const vaultDb = opts.vaultDb
  const notice = vaultDb === null && store.get(VAULT_UNBOUND_NOTICE_KEY) === undefined
  const result = await runRecallInjection(rawPrompt, store, opts, notice, vaultDb)
  if (!notice) return result
  store.set(VAULT_UNBOUND_NOTICE_KEY, Number.MAX_SAFE_INTEGER)
  store.flush?.()
  if (!result.skipped) return result
  // The notice replaces an empty injection, never the steps it skipped (@ag/tribe/25071).
  return {
    skipped: false,
    additionalContext: wrapInjectedContext({
      source: "recall",
      mode: "snippet",
      items: [vaultNoticeItem()],
      snippetChars: opts.snippetChars ?? 300,
    }),
    newKeys: [],
    turn: store.turn(),
    ...(result.skippedSteps === undefined ? {} : { skippedSteps: result.skippedSteps }),
  }
}

async function runRecallInjection(
  rawPrompt: string,
  store: SeenStore,
  opts: RunInjectDeltaOptions,
  notice: boolean,
  vaultDb: string | null,
): Promise<RunInjectDeltaResult> {
  const limitSnippets = opts.limit ?? 1
  const ttlTurns = opts.ttlTurns ?? 100
  const minLength = opts.minSnippetLength ?? 20
  const snippetChars = opts.snippetChars ?? 300
  const minRank = opts.minRank ?? MIN_RANK_THRESHOLD
  const deriveVaultAnchorImpl = opts.deps?.deriveVaultAnchor ?? deriveVaultAnchor

  const steps = opts.steps
  // Only the operator's own words reach salience, the vault anchor and recall (25071).
  const prompt = stripHarnessEnvelopes(rawPrompt)
  if (prompt.length === 0 && rawPrompt.trim().length > 0) {
    emitInjectionDebugEvent({
      source: "recall",
      action: "skip",
      reason: "harness_envelope",
      prompt: rawPrompt.slice(0, 200),
    })
    return { skipped: true, reason: "low_salience" }
  }
  const skipReason = timeStep(steps, "classify", () => classifyPromptSkip(prompt))
  if (skipReason && TRIVIAL_SKIP_REASONS.has(skipReason)) {
    emitInjectionDebugEvent({
      source: "recall",
      action: "skip",
      reason: skipReason,
      prompt: prompt.slice(0, 200),
    })
    return { skipped: true, reason: skipReason }
  }

  // V2 salience gate: short meta-prompts ("improve this", "what now?") have
  // no anchor for FTS to retrieve against — every match is incidental. Long
  // substantive prompts bypass the gate (the question itself is enough
  // signal). See prompt-filter.ts for the identifier shapes we recognize.
  //
  // Project-vocab override: a prompt token that resolves against the vault
  // (a bead title, a vault path, a frontmatter alias) is itself salient
  // signal even when it doesn't match the regex shapes (camelCase like
  // testEnv / createTestApp, bare project nouns like termless / Silvery).
  // We probe the vault FTS once and bypass the salience skip when it hits.
  // Directive guard runs FIRST and applies universally: imperative-shape
  // prompts ("re-open the bead", "create ONE bead", "fix all failures")
  // mention project terms in passing but aren't asking the agent to
  // recall about them. This catches the long-prompt-bypass false_emit
  // path where a directive happens to be 120+ chars, AND prompts with
  // legitimate salience patterns (kebab-id, file paths) that are still
  // commands.
  if (timeStep(steps, "classify", () => looksLikeDirective(prompt))) {
    emitInjectionDebugEvent({
      source: "recall",
      action: "skip",
      reason: "low_salience",
      prompt: prompt.slice(0, 200),
    })
    return { skipped: true, reason: "low_salience" }
  }

  // The vault anchor (vault-glossary.ts) is what call A searches the vault with: the first identifier the prompt
  // names and the content words after it. A question always searches, identifier or not (@cto 7f55e4f2: the cure
  // is to search, not to explain the skip); any other short prompt needs an identifier, by its regex shape
  // (prompt-filter.ts) or by the anchor's.
  const promptHasSalience = timeStep(steps, "classify", () => hasSalience(prompt))
  const anchor = timeStep(steps, "anchor", () => deriveVaultAnchorImpl(prompt, vaultDb))
  const questionShape = /[?]|^\s*(?:what|which|where|how|why|when|who)\b/i.test(prompt)

  if (!questionShape && prompt.length < LONG_PROMPT_BYPASS_LENGTH && !promptHasSalience && !anchor?.identifier) {
    emitInjectionDebugEvent({
      source: "recall",
      action: "skip",
      reason: "low_salience",
      prompt: prompt.slice(0, 200),
    })
    return { skipped: true, reason: "low_salience" }
  }

  // Carried in the result, so every caller (the hook library path and the daemon) can say what was skipped.
  const skippedSteps: Record<string, string> = {}
  const withSkippedSteps = <R extends RunInjectDeltaResult>(result: R): R =>
    Object.keys(skippedSteps).length > 0 ? { ...result, skippedSteps } : result

  const turn = timeStep(steps, "advance_turn", () => store.advanceTurn())

  const recallOpts: RecallOptions = {
    mode: "hook",
    limit: HOOK_RECALL_LIMIT,
    raw: true,
    timeout: 2000,
    snippetTokens: 80,
    json: true,
    // Inject path must NEVER recall fragments from the current session — that
    // creates the autocatalytic loop where transcript bytes from this very
    // turn become "memory" for the next prompt. The CLI keeps default false
    // so users can still grep their live session explicitly.
    excludeCurrentSession: true,
    // The vault rides the call: the prompt hook's recall runs in a Worker its --vault-db never reached.
    vaultDb,
  }
  // In-thread by default. The prompt hook, the one caller that exits, passes a deadline recall (@ag/tribe/25071
  // stopgap); a long-lived caller (the daemon, the plugin server) would stack queries a deadline abandons.
  const recallImpl = opts.deps?.recall ?? recall
  // Recall's own phases join the steps under the step's name, and a phase it skipped is said like a skipped step.
  const absorb = (step: string, answer: RecallResult): void => {
    for (const [name, ms] of Object.entries(answer.timing?.phases ?? {})) {
      if (steps) steps[`${step}.${name}`] = (steps[`${step}.${name}`] ?? 0) + ms
    }
    // Several skips of one phase are all said, in order (25397).
    for (const skip of answer.skipped ?? []) {
      const key = `${step}.${skip.phase}`
      const said = skippedSteps[key]
      skippedSteps[key] = said === undefined ? skip.message : `${said}; ${skip.message}`
    }
  }
  /** One recall call, timed as `step`, its phases absorbed; its own wall time comes back with its result. */
  const call = async (step: string, query: string, phases: readonly RecallPhase[]) => {
    const began = performance.now()
    const result = await timeStepAsync(steps, step, () => recallImpl(query, { ...recallOpts, phases }))
    absorb(step, result)
    return { result, ms: Math.round(performance.now() - began) }
  }
  const wall = `the ${String(RECALL_WALL_MS / 1000)} s wall`

  // Call A: the vault, on the anchor. It needs a vault and an anchor. If even A runs over the wall, nothing answered,
  // and the hook says so as it always has (@cto 7f55e4f2 bound 4).
  let vaultCall: Awaited<ReturnType<typeof call>> | null = null
  if (anchor !== null && vaultDb !== null) {
    try {
      vaultCall = await call("recall_vault", anchor.query, VAULT_PHASES)
    } catch (error) {
      if (!(error instanceof RecallDeadlineError)) throw error
      // Said in the hook output, not only its log: the turn runs without recall, and the reader should know why. The
      // line keeps the deadline's own words first, the prefix the eval's reader keys on (tools/recall-eval-hook.ts).
      const line = `${error.message}: the vault search for "${anchor.query}" did not finish, so nothing was searched after it`
      skippedSteps.recall_vault = line
      return withSkippedSteps({ skipped: false, additionalContext: line, newKeys: [], turn })
    }
  }

  const vaultQuery = vaultCall?.result.vaultQuery
  const vaultReceipt = vaultQuery === undefined ? {} : { vaultQuery }

  // Call B: the rest, on the prompt, bounded because FTS cost grows super-linearly with query length (25071). Over
  // the wall, A's answer stays and one line names what did not finish.
  let promptCall: Awaited<ReturnType<typeof call>> | null = null
  let partial: string | null = null
  try {
    promptCall = await call("recall", prompt.slice(0, MAX_RECALL_QUERY_CHARS), PROMPT_PHASES)
  } catch (error) {
    if (!(error instanceof RecallDeadlineError)) throw error
    if (vaultCall === null) {
      skippedSteps.recall = error.message
      return withSkippedSteps({ skipped: false, additionalContext: error.message, newKeys: [], turn })
    }
    partial = `recall partial: vault answered in ${String(vaultCall.ms)} ms; ${PROMPT_PHASES_SAID} did not finish inside ${wall} (25071)`
    skippedSteps.recall = partial
  }

  // The join is recall's own merge, so it never re-ranks (@cto 7f55e4f2 bound 3).
  const results = mergeRecallResults(
    [...(vaultCall?.result.results ?? []), ...(promptCall?.result.results ?? [])],
    HOOK_RECALL_LIMIT,
  )
  const frame = (framed: InjectedItem[]): string =>
    wrapInjectedContext({
      source: "recall",
      mode: "snippet",
      items: notice ? [vaultNoticeItem(), ...framed] : framed,
      // Forward recall's snippet cap so the chokepoint does not re-cap at its own
      // 300 default — a caller that set `snippetChars` above 300 would otherwise
      // be truncated silently (28904 review).
      snippetChars,
    })
  // Nothing to inject is said in one line naming what was searched and how long it took, never silence (Phase 3).
  const searched = (): string =>
    [
      ...(vaultCall && anchor ? [`the vault for "${anchor.query}" in ${String(vaultCall.ms)} ms`] : []),
      promptCall
        ? `${PROMPT_PHASES_SAID} for the prompt in ${String(promptCall.ms)} ms`
        : `${PROMPT_PHASES_SAID}, which did not finish inside ${wall}`,
    ].join(", and ")
  const sayEmpty = (
    reason: Extract<InjectSkipReason, "no_results" | "all_seen" | "low_quality">,
    outcome: string,
  ): RunInjectDeltaResult => {
    const said = searched()
    const line = `recall: ${outcome}; searched ${said} (25071)`
    // The envelope's debug stream; the authoritative row for this decision is the hook's own, timed one (29480).
    emitInjectionDebugEvent({ source: "recall", action: "skip", reason, prompt: prompt.slice(0, 200) })
    return withSkippedSteps({
      skipped: false,
      additionalContext: frame([recallNoticeItem(line)]),
      newKeys: [],
      turn,
      emptyRecallReason: reason,
      searched: said,
      ...vaultReceipt,
    })
  }

  if (results.length === 0) return sayEmpty("no_results", "nothing found")

  const items: InjectedItem[] = []
  const newKeys: string[] = []
  let sawAnyAfterRankGate = false
  for (const r of results) {
    // V2 quality gate: drop weak FTS matches before any other work.
    if (r.rank > minRank) continue
    sawAnyAfterRankGate = true

    const key = `${r.sessionId}:${r.type}`
    const lastTurn = store.get(key)
    if (lastTurn !== undefined && turn - lastTurn < ttlTurns) continue
    const text = cleanSnippet(r.snippet)
    if (text.length < minLength) continue
    // V2 content gate: drop snippets that are their own evidence of
    // irrelevance — stored verdicts ("orthogonal"/"incidental"), beads in
    // SUPERSEDED/REJECTED state, etc. Catches the literal "verdict: orthogonal"
    // emit we observed in dogfooding.
    if (containsRejectedSignal(text)) continue

    const label = r.sessionTitle ?? r.sessionId.slice(0, 8)
    // A vault match's locator IS a path (an fs_path or node id), not an opaque
    // session UUID — so it rides in `path` ONLY. Emitting it as `sessionId` too
    // would make the chokepoint render a truncated 8-char `session` attribute
    // AND make the chat row prefer that truncated session over the full path
    // (the 28904 review's compatibility MUST). A session-backed item keeps its
    // (truncatable) `sessionId`.
    items.push({
      title: label,
      snippet: text.slice(0, snippetChars),
      type: r.type,
      ...(r.type === "vault" ? { path: r.sessionId } : { sessionId: r.sessionId }),
    })
    newKeys.push(key)
    if (items.length >= limitSnippets) break
  }

  for (const k of newKeys) store.set(k, turn)

  if (store.size() > 500) store.gc(turn - ttlTurns * 4)
  store.flush?.()

  if (items.length === 0) {
    // Two empty-after-recall cases, each said with what was searched:
    //   - low_quality: every result failed the rank gate (noise)
    //   - all_seen:    everything past the rank gate was already injected, too short, or its own rejection
    const found = `${String(results.length)} result${results.length === 1 ? "" : "s"}`
    return sawAnyAfterRankGate
      ? sayEmpty("all_seen", `${found}, each already shown this session or filtered as noise`)
      : sayEmpty("low_quality", `${found}, none strong enough to show`)
  }

  // The recall emit path routes through the injection-envelope chokepoint, so
  // the `<injected_context>` envelope, its directive attributes, the imperative
  // rewrite, the `<item>` framing and the protocol footer all come from ONE
  // implementation shared with every other emitter. The legacy `<recall-memory>`
  // / `<snippet>` markup disappears with this change (@km/bearly/14871). A partial
  // answer leads with the line naming what did not finish.
  const additionalContext = frame(partial === null ? items : [recallNoticeItem(partial), ...items])

  emitInjectionDebugEvent({
    source: "recall",
    action: "emit",
    prompt: prompt.slice(0, 200),
    itemCount: items.length,
    chars: additionalContext.length,
    additionalContext,
  })

  return withSkippedSteps({
    skipped: false,
    additionalContext,
    newKeys,
    turn,
    ...vaultReceipt,
  })
}

// ---------------------------------------------------------------------------
// Ready-made stores
// ---------------------------------------------------------------------------

/**
 * In-memory store for daemon use. Hot-path reads/writes on a Map.
 * One instance per session; the daemon keeps them in a Map<sessionId, ...>.
 */
export function createMemorySeenStore(initial?: { turn: number; seen: Map<string, number> }): SeenStore {
  const state = initial ?? { turn: 0, seen: new Map<string, number>() }
  return {
    turn: () => state.turn,
    advanceTurn: () => ++state.turn,
    get: (k) => state.seen.get(k),
    set: (k, t) => void state.seen.set(k, t),
    size: () => state.seen.size,
    gc: (minTurn) => {
      for (const [k, t] of state.seen) if (t < minTurn) state.seen.delete(k)
    },
  }
}

/**
 * Tmpfile-backed store for the library fallback path. Reads on construction,
 * writes on flush(). Identified by an opaque `sessionId` (pass undefined for
 * an in-memory no-dedup fallback — matches pre-daemon hookRecall semantics
 * when CLAUDE_SESSION_ID isn't set).
 */
export function createTmpfileSeenStore(filePath: string | null): SeenStore {
  // Read once at construction; hookRecall used to read on every call, but
  // hookRecall is itself called once per UserPromptSubmit so one read is
  // the same cost.
  let seen: Record<string, number> = {}
  let turn = 0
  if (filePath) {
    try {
      const raw = readFileSync(filePath, "utf8")
      const data = JSON.parse(raw) as { seen?: Record<string, number>; turn?: number }
      seen = data.seen ?? {}
      turn = data.turn ?? 0
    } catch {
      // First call in session or corrupt file — reset.
    }
  }
  return {
    turn: () => turn,
    advanceTurn: () => ++turn,
    get: (k) => seen[k],
    set: (k, t) => void (seen[k] = t),
    size: () => Object.keys(seen).length,
    gc: (minTurn) => {
      for (const k in seen) if ((seen[k] ?? 0) < minTurn) delete seen[k]
    },
    flush: () => {
      if (!filePath) return
      try {
        writeFileSync(filePath, JSON.stringify({ turn, seen }))
      } catch {
        // Non-fatal — best-effort persistence.
      }
    },
  }
}
