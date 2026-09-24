/**
 * The prompt hook's recall budget: the one place it is stated (@ag/tribe/25071 row 2, @cto ruling 2026-09-23 on
 * packet /hh/var/@dev/11/25071/r2/packet.md).
 *
 * Measured before the ruling, 2026-09-23, on the live 13 GB index opened read-only at load 30 to 45:
 * - under the 5 s stopgap, 24 of 62 prompts that reached recall hit the wall; recall p50 was 1.45 s;
 * - the exact path's COUNT over every match costs up to 10x its ranked search cold (yrd*: 36 s against 3.4 s), and
 *   the session-depth corroboration's GROUP BY over every all-time match took 14.5 s on tribe*;
 * - an FTS-native candidate pass (top N by bm25, then join, window and collapse) took 36 to 775 ms at N=1000 and 52
 *   to 686 ms at N=5000, median about 400 ms either way (candidate-pass-cost.txt), on single anchors. On real prompts
 *   (about 160 characters of common words) that pass was slower than exact's window-first ranking on 84 of 150, so
 *   hook mode ranks the window first (@cto re-ruling 516d4c10; /hh/var/@dev/11/25071-r2/replay.jsonl).
 *
 * The target is what the user waits for; the wall is the failure bound, where recall is skipped loudly.
 */

/** What the prompt hook's recall aims to finish inside. */
export const RECALL_TARGET_MS = 1000

/** The hard wall: past it the hook skips recall loudly instead of waiting (the Worker in recall-deadline.ts). */
export const RECALL_WALL_MS = 1500

/** Hook mode ranks at most this many window matches (the window first, then bm25; @cto re-ruling 516d4c10). */
export const HOOK_CANDIDATE_LIMIT = 1000

/**
 * The measured cost of one window-first candidate pass: the messages phase's median over the 25071 row 2 replay
 * (160 recalled prompts from 14 days, 492 ms; 25397). A budgeted phase (each synonym variant, the glossary fallback)
 * starts only while more than this is left before the wall. A synonym variant costs less (median 297 ms) and the
 * fallback, a whole recall, more (median 826 ms); the wall bounds either way.
 */
export const HOOK_CANDIDATE_PASS_MS = 500
