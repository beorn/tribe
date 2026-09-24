/**
 * The prompt hook's recall budget: the one place it is stated (@ag/tribe/25071 row 2, @cto ruling 2026-09-23 on
 * packet /hh/var/@dev/11/25071/r2/packet.md).
 *
 * Measured before the ruling, 2026-09-23, on the live 13 GB index opened read-only at load 30 to 45:
 * - under the 5 s stopgap, 24 of 62 prompts that reached recall hit the wall; recall p50 was 1.45 s;
 * - the exact path's COUNT over every match costs up to 10x its ranked search cold (yrd*: 36 s against 3.4 s), and
 *   the session-depth corroboration's GROUP BY over every all-time match took 14.5 s on tribe*;
 * - an FTS-native candidate pass (top N by bm25, then join, window and collapse) took 36 to 775 ms at N=1000 and 52
 *   to 686 ms at N=5000, median about 400 ms either way (candidate-pass-cost.txt).
 *
 * The target is what the user waits for; the wall is the failure bound, where recall is skipped loudly.
 */

/** What the prompt hook's recall aims to finish inside. */
export const RECALL_TARGET_MS = 1000

/** The hard wall: past it the hook skips recall loudly instead of waiting (the Worker in recall-deadline.ts). */
export const RECALL_WALL_MS = 1500

/** Hook mode ranks this many FTS candidates first. */
export const HOOK_CANDIDATE_LIMIT = 1000

/** The one widening, when the window keeps too few of the first candidates. */
export const HOOK_WIDE_CANDIDATE_LIMIT = 5000

/** No hook candidate set is ever smaller: at 200 the window kept 0 of the top ten for tribe* and queue*. */
export const HOOK_CANDIDATE_FLOOR = 500

/** Fewer in-window survivors than this, even after widening, skips the message phase loudly. */
export const HOOK_MIN_SURVIVORS = 10

/**
 * The measured cost of one candidate pass (median of ten, candidate-pass-cost.txt). A budgeted phase (the widening,
 * each synonym variant, the glossary fallback) starts only while more than this is left before the wall.
 */
export const HOOK_CANDIDATE_PASS_MS = 400
