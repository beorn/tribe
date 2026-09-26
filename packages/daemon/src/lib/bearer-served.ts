/**
 * Every resolution the launcher-minted bearer serves, as one journal row (25074 3d-3 prerequisite; @cto 6a02149d
 * rider 1, ruling 8c095897). 3d-3 deletes the bearer path, and its gate is a COUNT over a window that covers every
 * seat's relaunch, not a members snapshot: a snapshot proves only the present.
 *
 * One record: the existing event journal (`logEvent`, kind 'event', never delivered, never actionable). The type sits
 * beside `session.identity-promoted`; the seat is the row's `sender`, as every `session.*` event writes it, and `ref`
 * stays free for request ids. One writer, {@link recordBearerServed}, over a closed branch union; one reader,
 * {@link countBearerServed}, over both journal halves. Nothing here changes what any branch answers.
 */

import type { TribeContext } from "./context.ts"
import { logEvent } from "./messaging.ts"

/**
 * The five places the bearer serves (with-dispatcher.ts): four on the one-shot authority path, one at register.
 * - verifier-fault: the verifier could not decide the token, and a valid bearer beside it served the call (03cff4b5).
 * - no-session-for-sid: the token verified, but no session is registered under its sid yet.
 * - token-unreadable: the verifier called the token unreadable, and the call fell through to the bearer.
 * - no-token: no token was presented, or the daemon has no verifier to judge it (`token_presented` says which).
 * - register-bearer: a registration keyed by the bearer hash rather than a verified token.
 */
export const BEARER_SERVED_BRANCHES = [
  "verifier-fault",
  "no-session-for-sid",
  "token-unreadable",
  "no-token",
  "register-bearer",
] as const
export type BearerServedBranch = (typeof BEARER_SERVED_BRANCHES)[number]

/** The journal type, without logEvent's `event.` prefix. */
export const BEARER_SERVED_EVENT = "session.bearer-served"
const BEARER_SERVED_TYPE = `event.${BEARER_SERVED_EVENT}`

function bearerServedPath(branch: BearerServedBranch): "one-shot" | "register" {
  switch (branch) {
    case "verifier-fault":
    case "no-session-for-sid":
    case "token-unreadable":
    case "no-token":
      return "one-shot"
    case "register-bearer":
      return "register"
    default: {
      const unreachable: never = branch
      throw new Error(`bearer-served: unknown branch ${String(unreachable)}`)
    }
  }
}

/**
 * Record one bearer-served resolution on the SERVED session's context, so the row's sender is that seat and its
 * session_id that session. `launchId` is the served session's launch (null for a hand session, which the reader
 * reports apart from the gate).
 */
export function recordBearerServed(
  ctx: TribeContext,
  branch: BearerServedBranch,
  launchId: string | null,
  detail: Readonly<Record<string, unknown>> = {},
): void {
  logEvent(ctx, BEARER_SERVED_EVENT, undefined, {
    ...detail,
    name: ctx.getName(),
    session_id: ctx.sessionId,
    branch,
    path: bearerServedPath(branch),
    launch_id: launchId,
  })
}

export type BearerServedTally = {
  total: number
  by_branch: Record<BearerServedBranch, number>
  by_name: Record<string, number>
}

/**
 * The count for one window. `gate` holds the rows with a launch id (3d-3 needs it at zero); `hand` holds the rows
 * without one (a hand session: visible, never blocking). `truncated_at` is set when the journal has deleted rows and
 * `since` predates the oldest one it still retains; `note` says so, so a 0 over a pruned window never reads as a
 * measurement.
 */
export type BearerServedCount = {
  since: string
  to: string
  halves: readonly ["messages", "messages_archive"]
  oldest_retained: string | null
  truncated_at: string | null
  note: string
  gate: BearerServedTally
  hand: BearerServedTally
}

type TallyRow = { name: string; branch: string | null; hand: number; n: number }

function emptyTally(): BearerServedTally {
  return {
    total: 0,
    by_branch: Object.fromEntries(BEARER_SERVED_BRANCHES.map((branch) => [branch, 0])) as Record<
      BearerServedBranch,
      number
    >,
    by_name: {},
  }
}

function isBearerServedBranch(value: string | null): value is BearerServedBranch {
  return value !== null && (BEARER_SERVED_BRANCHES as readonly string[]).includes(value)
}

/** Count bearer-served rows with `since <= ts <= to` across messages and messages_archive. */
export function countBearerServed(db: TribeContext["db"], window: { since: number; to: number }): BearerServedCount {
  if (!Number.isFinite(window.since) || !Number.isFinite(window.to) || window.since > window.to) {
    throw new Error(`bearer-served: invalid window since=${String(window.since)} to=${String(window.to)}`)
  }
  const tallyQuery = (table: "messages" | "messages_archive") =>
    db.prepare(`
      SELECT sender AS name,
             json_extract(content, '$.branch') AS branch,
             (json_extract(content, '$.launch_id') IS NULL) AS hand,
             COUNT(*) AS n
      FROM ${table}
      WHERE kind = 'event' AND type = $type AND ts >= $since AND ts <= $to
      GROUP BY name, branch, hand
    `)
  const bind = { $type: BEARER_SERVED_TYPE, $since: window.since, $to: window.to }
  const rows = [
    ...(tallyQuery("messages").all(bind) as TallyRow[]),
    ...(tallyQuery("messages_archive").all(bind) as TallyRow[]),
  ]
  const gate = emptyTally()
  const hand = emptyTally()
  for (const row of rows) {
    if (!isBearerServedBranch(row.branch)) {
      throw new Error(`bearer-served: a journal row names an unknown branch ${JSON.stringify(row.branch)}`)
    }
    const tally = row.hand === 1 ? hand : gate
    tally.total += row.n
    tally.by_branch[row.branch] += row.n
    tally.by_name[row.name] = (tally.by_name[row.name] ?? 0) + row.n
  }

  // messages.rowid and messages_archive.seq share one AUTOINCREMENT space from 1, so a lowest retained seq above 1
  // means retention (or anything else) deleted rows. Only then can rows older than the oldest retained one be missing;
  // a young journal whose first row is still here is complete, and a window before it has nothing uncounted.
  const lowest = (sql: string) => (db.prepare(sql).get() as { v: number | null } | null)?.v ?? null
  const seqs = [lowest("SELECT MIN(rowid) AS v FROM messages"), lowest("SELECT MIN(seq) AS v FROM messages_archive")]
  const stamps = [lowest("SELECT MIN(ts) AS v FROM messages"), lowest("SELECT MIN(ts) AS v FROM messages_archive")]
  const retainedSeqs = seqs.filter((v): v is number => v !== null)
  const retainedStamps = stamps.filter((v): v is number => v !== null)
  const oldest = retainedStamps.length === 0 ? null : Math.min(...retainedStamps)
  const pruned = retainedSeqs.length > 0 && Math.min(...retainedSeqs) > 1
  const truncated = pruned && oldest !== null && window.since < oldest
  const since = new Date(window.since).toISOString()
  const to = new Date(window.to).toISOString()
  return {
    since,
    to,
    halves: ["messages", "messages_archive"],
    oldest_retained: oldest === null ? null : new Date(oldest).toISOString(),
    truncated_at: truncated && oldest !== null ? new Date(oldest).toISOString() : null,
    note:
      truncated && oldest !== null
        ? `window truncated at ${new Date(oldest).toISOString()}: the journal retains nothing older, so rows between ${since} and then are not counted`
      : `counted ${since} to ${to} across messages and messages_archive`,
    gate,
    hand,
  }
}
