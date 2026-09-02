/**
 * Tribe session — registration, delivery offsets, transcript naming, cleanup.
 */

import { createLogger } from "loggily"
import type { Database } from "bun:sqlite"
import { readTranscriptSlug } from "tribe-wire/lib/transcript"
import type { TribeContext } from "./context.ts"
import { probeProcessState } from "./session-transport-state.ts"

const log = createLogger("tribe:session")
import { sendMessage, logEvent, settlePendingRows, type PendingSettlementRow } from "./messaging.ts"

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown when a session can't register or rename because the desired name is
 *  held by another active session. `existing_names` enumerates the currently-
 *  connected names so callers can suggest alternatives without an extra
 *  `tribe.sessions` round-trip. `holder_pid` (when known) is the OS PID of
 *  the live process currently holding the name — surfaces actionable info
 *  for spawn-time identity-binding (the user can verify the conflict is a
 *  real second instance, not a stale daemon-side ghost). */
export class NameConflictError extends Error {
  constructor(
    readonly desiredName: string,
    readonly existing_names: string[],
    readonly holder_pid: number | null = null,
  ) {
    super(
      holder_pid != null
        ? `Name "${desiredName}" is already taken by live pid ${holder_pid}`
        : `Name "${desiredName}" is already taken`,
    )
    this.name = "NameConflictError"
  }
}

function listSessionNames(ctx: TribeContext, isActive?: (sessionId: string) => boolean): string[] {
  const rows = ctx.db.prepare("SELECT id, name FROM sessions").all() as Array<{ id: string; name: string }>
  return rows
    .filter((r) => (isActive ? isActive(r.id) : true))
    .map((r) => r.name)
    .sort()
}

export type SessionRegistrationLifetime = "connection-scoped" | "durable-launch" | "malformed-launch-identity"

export function classifySessionRegistrationLifetime(input: {
  launchId: string | null
  launchParentPid: number | null
}): SessionRegistrationLifetime {
  const hasLaunchId = typeof input.launchId === "string" && input.launchId.trim().length > 0
  const hasLaunchParentPid =
    typeof input.launchParentPid === "number" &&
    Number.isSafeInteger(input.launchParentPid) &&
    input.launchParentPid > 0
  if (hasLaunchId && hasLaunchParentPid) return "durable-launch"
  if (input.launchId === null && input.launchParentPid === null) return "connection-scoped"
  return "malformed-launch-identity"
}

export type StaleTransportReapReasonCounts = {
  active_transport: number
  reconnect_grace: number
  durable_launch: number
  malformed_launch_identity: number
  reaped_connection_scoped: number
  reaped_superseded_launch: number
}

export type StaleTransportReapReport = {
  examined: number
  reaped: number
  reason_counts: StaleTransportReapReasonCounts
  reaped_sessions: Array<{ member_id: string; name: string }>
}

/**
 * The launch ids currently held by connected sessions — the supersession
 * evidence the reaper and the read-time projections both need. Sessions with
 * no launch id (legacy connection-scoped registrations) contribute nothing.
 */
export function activeLaunchIds(active: ReadonlyArray<{ launchId: string | null }>): Set<string> {
  const launchIds = new Set<string>()
  for (const session of active) {
    const launchId = session.launchId?.trim()
    if (launchId) launchIds.add(launchId)
  }
  return launchIds
}

export type StaleTransportReapOpts = {
  nowMs?: number
  hasActiveTransport: (sessionId: string) => boolean
  isReconnectGraceProtected: (sessionId: string, nowMs: number) => boolean
  /**
   * Launch ids currently held by a connected session. A durable-launch row
   * whose launch id appears here has been provably replaced by a live
   * registration, so the repair can reach it without ever consulting the dead
   * transport it is repairing. Omitted means "no supersession evidence" —
   * then durable rows are preserved exactly as before.
   */
  getActiveLaunchIds?: () => ReadonlySet<string>
  /**
   * Restrict the scan to these session ids. The periodic sweep omits it and
   * examines every row; the disconnect-driven collection passes the sessions
   * whose transports just died, so routine churn costs one indexed lookup per
   * departed session instead of a full table scan per disconnect.
   *
   * Scoping changes only which rows are EXAMINED, never the policy applied to
   * them: every fence below — active transport, lifetime classification,
   * supersession, reconnect grace, and the re-read inside the transaction —
   * runs identically either way, so a row can never be reaped on the scoped
   * path that the sweep would have preserved.
   */
  onlySessionIds?: ReadonlySet<string>
}

/**
 * Reap disconnected connection-scoped registrations without guessing from
 * names, activity timestamps, or numeric PID existence. All classification is
 * synchronous, and active transport is checked again immediately before the
 * transaction deletes a row.
 *
 * Durable-launch rows are preserved unless a LIVE registration holds the same
 * launch id: a missing transport still never establishes agent absence, so
 * only positive evidence of replacement makes a durable row reapable.
 */
export function reapStaleTransportRows(db: Database, opts: StaleTransportReapOpts): StaleTransportReapReport {
  const nowMs = opts.nowMs ?? Date.now()
  const scoped = opts.onlySessionIds
  const selectScopedRow =
    scoped === undefined
      ? null
      : db.prepare("SELECT id, name, launch_id, launch_parent_pid FROM sessions WHERE id = $id")
  const rows = (
    selectScopedRow === null
      ? db.prepare("SELECT id, name, launch_id, launch_parent_pid FROM sessions ORDER BY id").all()
      : [...(scoped as ReadonlySet<string>)].flatMap((sessionId) => selectScopedRow.all({ $id: sessionId }))
  ) as Array<{
    id: string
    name: string
    launch_id: string | null
    launch_parent_pid: number | null
  }>
  const reasonCounts: StaleTransportReapReasonCounts = {
    active_transport: 0,
    reconnect_grace: 0,
    durable_launch: 0,
    malformed_launch_identity: 0,
    reaped_connection_scoped: 0,
    reaped_superseded_launch: 0,
  }
  const activeLaunchIds = opts.getActiveLaunchIds?.() ?? new Set<string>()
  const isSupersededLaunch = (launchId: string | null): boolean =>
    typeof launchId === "string" && launchId.length > 0 && activeLaunchIds.has(launchId)
  const candidates: Array<(typeof rows)[number] & { superseded: boolean }> = []

  for (const row of rows) {
    if (opts.hasActiveTransport(row.id)) {
      reasonCounts.active_transport++
      continue
    }
    const lifetime = classifySessionRegistrationLifetime({
      launchId: row.launch_id,
      launchParentPid: row.launch_parent_pid,
    })
    const superseded = isSupersededLaunch(row.launch_id)
    if (lifetime === "durable-launch" && !superseded) {
      reasonCounts.durable_launch++
      continue
    }
    if (lifetime === "malformed-launch-identity" && !superseded) {
      reasonCounts.malformed_launch_identity++
      continue
    }
    if (opts.isReconnectGraceProtected(row.id, nowMs)) {
      reasonCounts.reconnect_grace++
      continue
    }
    candidates.push({ ...row, superseded })
  }

  const reapedSessions: Array<{ member_id: string; name: string }> = []
  const getCurrent = db.prepare("SELECT id, name, launch_id, launch_parent_pid FROM sessions WHERE id = $id LIMIT 1")
  const deleteRoomMembers = db.prepare("DELETE FROM room_members WHERE session_id = $id")
  const deleteSession = db.prepare("DELETE FROM sessions WHERE id = $id")

  db.transaction(() => {
    for (const candidate of candidates) {
      // The daemon dispatcher is single-threaded between awaits. This final
      // no-await registry read is the race fence for a sibling that connected
      // after the first classification pass.
      if (opts.hasActiveTransport(candidate.id)) {
        reasonCounts.active_transport++
        continue
      }
      const current = getCurrent.get({ $id: candidate.id }) as {
        id: string
        name: string
        launch_id: string | null
        launch_parent_pid: number | null
      } | null
      if (!current) continue
      const currentLifetime = classifySessionRegistrationLifetime({
        launchId: current.launch_id,
        launchParentPid: current.launch_parent_pid,
      })
      const currentSuperseded = isSupersededLaunch(current.launch_id)
      if (currentLifetime === "durable-launch" && !currentSuperseded) {
        reasonCounts.durable_launch++
        continue
      }
      if (currentLifetime === "malformed-launch-identity" && !currentSuperseded) {
        reasonCounts.malformed_launch_identity++
        continue
      }
      if (opts.isReconnectGraceProtected(current.id, nowMs)) {
        reasonCounts.reconnect_grace++
        continue
      }
      deleteRoomMembers.run({ $id: current.id })
      const deleted = deleteSession.run({ $id: current.id })
      if (Number(deleted.changes ?? 0) === 1) {
        if (currentSuperseded) reasonCounts.reaped_superseded_launch++
        else reasonCounts.reaped_connection_scoped++
        reapedSessions.push({ member_id: current.id, name: current.name })
      }
    }
  })()

  return {
    examined: rows.length,
    reaped: reapedSessions.length,
    reason_counts: reasonCounts,
    reaped_sessions: reapedSessions,
  }
}

/** GC explicit takeover tombstones. They are forensic breadcrumbs, not
 * durable routable names. Generated transports are deliberately excluded:
 * the post-startup stale-transport reaper must give them reconnect grace
 * before applying connection-scoped lifetime semantics. */
export function sweepDeadSessionRows(
  db: Database,
  maxAgeMs: number,
  nowMs = Date.now(),
  activeSessionIds: ReadonlySet<string> = new Set(),
): number {
  const cutoff = nowMs - maxAgeMs
  const activeIds = [...activeSessionIds]
  const activeClause = activeIds.length > 0 ? ` AND id NOT IN (${activeIds.map(() => "?").join(", ")})` : ""
  const candidates = db
    .prepare(
      `SELECT id, name FROM sessions
       WHERE updated_at < ?
         AND name GLOB '*-dead-*'${activeClause}`,
    )
    .all(cutoff, ...activeIds) as Array<{ id: string; name: string }>
  if (candidates.length === 0) return 0

  const ids = candidates.map((candidate) => candidate.id)
  const placeholders = ids.map(() => "?").join(", ")
  return db.transaction(() => {
    db.prepare(`DELETE FROM room_members WHERE session_id IN (${placeholders})`).run(...ids)
    const res = db.prepare(`DELETE FROM sessions WHERE id IN (${placeholders})`).run(...ids)
    return Number(res.changes ?? 0)
  })()
}

/**
 * Count registered session rows that outlive their transport — the DB half of
 * the idle-quit client census (`withIdleQuit`). This is the complement of the
 * stale-transport reaper's "connection-scoped" classification: any row
 * carrying launch identity (durable-launch, and conservatively the malformed
 * rows the reaper also preserves) represents a live registered seat whose
 * transports legitimately come and go — a pull-delivery seat connects per
 * poll, so between polls it has a row and no socket. On 2026-08-12 thirteen
 * such rows read as "no clients" and idle-quit stopped the fleet rail.
 * Connection-scoped rows are excluded: their liveness IS their socket, which
 * the in-memory client registry already counts. Exact identities retired by
 * composing-layer policy remain stored as history but no longer keep the
 * daemon alive as a registered-seat workload.
 */
export function countDurableSessionRows(db: Database, retiredNames: ReadonlySet<string> = new Set()): number {
  const retired = [...retiredNames]
  const exclusion = retired.length === 0 ? "" : ` AND name NOT IN (${retired.map(() => "?").join(", ")})`
  const row = db
    .query(
      `SELECT COUNT(*) AS n FROM sessions WHERE (launch_id IS NOT NULL OR launch_parent_pid IS NOT NULL)${exclusion}`,
    )
    .get(...retired) as { n: number }
  return row.n
}

/** True iff the given OS PID exists and we have permission to signal it.
 *  Used by spawn-time identity binding to differentiate "zombie session
 *  the daemon thinks is alive but whose owning process is gone" from
 *  "real second instance of the same name". A zero PID means "unknown"
 *  (we don't store PIDs for pre-pid-binding sessions) — be conservative
 *  and treat it as alive so we don't accidentally evict a legitimate
 *  holder whose pid we just don't know about. */
export function isPidAlive(pid: number): boolean {
  // Existing callers use a conservative name-conflict gate: only positive
  // ESRCH evidence permits eviction. Process existence never enters the
  // disconnected transport/owner projection because a numeric PID is reusable.
  return probeProcessState(pid) !== "dead"
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register a session in the DB.
 *
 * The `isActive` callback tells the registrar whether a pre-existing row that
 * holds the desired name belongs to a currently-connected session. If the
 * holder is no longer active (its socket is gone from the daemon's `clients`
 * Map), we overwrite its row — there is no point in preserving a dead row's
 * name. If the holder IS active, we fall back to a random suffix so two
 * living sessions never share a name.
 *
 * This replaces the old heartbeat-based eviction: before Phase 2 of
 * km-tribe.plateau we evicted rows with `heartbeat < cutoff`; now that
 * liveness lives in the daemon's Map (not a DB timer), the Map is the only
 * source of truth.
 */
export function registerSession(
  ctx: TribeContext,
  projectId?: string,
  isActive?: (sessionId: string) => boolean,
  identityToken?: string | null,
  clientPid?: number,
  delivery?: "push" | "pull",
  clientCwd?: string,
  account?: string | null,
  provider?: string | null,
  launchId?: string | null,
  launchParentPid?: number | null,
  mailboxAuthorityHash?: string | null,
): void {
  const desiredName = ctx.getName()
  const now = Date.now()
  // The authenticated socket is transport truth. The client's OS PID is only
  // a negative fence while that socket is active; it never identifies the
  // owner of a disconnected row because PIDs are reusable. process.pid here
  // is the DAEMON's PID, so fall back to 0 if the caller supplied none.
  const pid = clientPid && clientPid > 0 ? clientPid : 0

  // If another row holds our desired name, drop it if either (a) its session
  // is NOT currently connected, OR (b) the daemon thinks it's connected but
  // the owning OS PID is actually dead (zombie session — socket-close handler
  // hasn't fired yet, e.g. parent crashed with the socket inherited by a
  // child shell that hasn't exited). PID liveness is the structural fence:
  // L4 of @km/tribe/spawn-time-identity-binding requires that no two live
  // PIDs share a persona at once, but a dead-pid placeholder must yield.
  const holder = ctx.db
    .prepare("SELECT id, pid FROM sessions WHERE name = $name AND id != $id")
    .get({ $name: desiredName, $id: ctx.sessionId }) as { id: string; pid: number } | null
  if (holder) {
    const holderActive = isActive ? isActive(holder.id) : false
    if (!holderActive) {
      ctx.db.prepare("DELETE FROM sessions WHERE id = $id").run({ $id: holder.id })
      log.debug?.(`evicted stale session row holding name "${desiredName}"`)
    } else if (!isPidAlive(holder.pid)) {
      // Daemon's clients map still has this session, but its PID is dead.
      // The socket-close handler will catch up eventually, but spawn-time
      // identity binding can't wait for that. Take over now.
      ctx.db.prepare("DELETE FROM sessions WHERE id = $id").run({ $id: holder.id })
      log.info?.(`evicted zombie session row "${desiredName}" (stored pid ${holder.pid} dead)`)
    }
  }

  // If the name is still taken after eviction attempts, check PID liveness
  // one more time (the holder's socket may linger after process exit). If the
  // holder's PID is genuinely alive, auto-suffix so registration always succeeds.
  let finalName = desiredName
  const takenCheck = ctx.db
    .prepare("SELECT id, pid FROM sessions WHERE name = $name AND id != $id")
    .get({ $name: finalName, $id: ctx.sessionId }) as { id: string; pid: number } | null
  if (takenCheck && isActive?.(takenCheck.id)) {
    // One more PID liveness check — catches the common restart case where
    // the old process exited but the socket-close handler hasn't fired yet.
    if (takenCheck.pid > 0 && !isPidAlive(takenCheck.pid)) {
      ctx.db.prepare("DELETE FROM sessions WHERE id = $id").run({ $id: takenCheck.id })
      log.info?.(`evicted zombie holder "${desiredName}" (pid ${takenCheck.pid} dead) during registration`)
    } else {
      // Genuinely two live sessions want the same name — auto-suffix.
      for (let n = 2; n <= 100; n++) {
        const candidate = `${desiredName}-${n}`
        const taken = ctx.db
          .prepare("SELECT id FROM sessions WHERE name = $name AND id != $id")
          .get({ $name: candidate, $id: ctx.sessionId }) as { id: string } | null
        if (!taken || !isActive(taken.id)) {
          finalName = candidate
          log.info?.(`name "${desiredName}" taken by active session; auto-assigned "${finalName}"`)
          ctx.setName(finalName)
          break
        }
      }
    }
  }

  // Registration deliberately does NOT retire other rows sharing this
  // `launch_id`. Two later mechanisms already cover a replaced registration,
  // and both conclude replacement only from a transport that is PRESENT, so
  // neither can race a registration still in flight:
  //
  //   - the read-time projection in `handlers.ts` drops disconnected rows
  //     whose launch id a live session holds, so a replaced row is invisible
  //     to every consumer of `tribe.members` / `tribe.health`;
  //   - `reapStaleTransportRows` physically removes it, behind a
  //     `hasActiveTransport` check re-read inside the delete transaction.
  //
  // A third cleanup at write time would buy only marginal latency on row
  // removal, and it is the only one of the three with a race window: the
  // dispatcher's same-launch fan-in normally adopts the holder's ctx so
  // siblings share a session id, but it matches on session NAME, and
  // concurrent adapters from one provider launch can pass through
  // registration before any name-holder exists to fan in to. Deleting on
  // `launch_id` here then destroys live siblings' rows — the three-adapter
  // fan-in journey lost two of its three `transport_pids`. No fence closes
  // it: a sibling mid-registration is not yet active and its pid is alive.
  // Dropping the write-time pass is consolidation, not lost coverage.

  try {
    ctx.stmts.upsertSession.run({
      $id: ctx.sessionId,
      $name: finalName,
      $role: ctx.sessionRole,
      $domains: JSON.stringify(ctx.domains),
      $pid: pid,
      $cwd: clientCwd || process.cwd(),
      $project_id: projectId ?? null,
      $claude_session_id: ctx.claudeSessionId,
      $claude_session_name: ctx.claudeSessionName,
      $identity_token: identityToken ?? null,
      $mailbox_authority_hash: mailboxAuthorityHash ?? null,
      $launch_id: launchId ?? null,
      $launch_parent_pid: launchParentPid ?? null,
      $now: now,
      $delivery: delivery ?? "push",
      $account: account ?? null,
      $provider: provider ?? null,
    })
  } catch {
    // Shouldn't happen after auto-suffix, but surface as typed error if it does.
    throw new NameConflictError(finalName, listSessionNames(ctx, isActive), holder?.pid ?? null)
  }

  // ROOMS DELETED — @cto ruling 2026-08-13. This used to auto-join every
  // session to its project's default room on the Matrix-shape plan. Measured
  // before removal: room_id was set on 0 of 87,738 messages, `with-broadcast.ts`
  // never mentioned rooms, and NOTHING read room_members — broadcast has always
  // been a name match over connected clients. The table was write-only.
  //
  // The cost of keeping it: 2,626 membership rows, 97.6% of them referencing
  // sessions that no longer exist, with no foreign key and no cascade. 1,551
  // arrived in a single three-hour window, one row per ephemeral session, because
  // membership was keyed by session rather than by name — so a subagent that
  // connected once became a permanent member of a project room forever.
  //
  // "A speculative surface wearing production schema" (@cto). A future need
  // re-earns its way in against the protocol layers, not via a parked maybe.

  logEvent(ctx, "session.joined", undefined, {
    name: ctx.getName(),
    role: ctx.sessionRole,
    domains: ctx.domains,
  })

  // km-tribe.delivery-correctness P1.3: the old cursor-init block seeded a
  // per-session entry in the now-dropped `cursors` table with multi-strategy
  // recovery (identity_token → claude_session_id → pid → skip-to-latest).
  // Nothing in the post-event-bus code path reads from `cursors`. Reconnects
  // now reset `sessions.last_delivered_seq`/`last_inbox_pull_seq` to the log
  // tail during registration, so no stale delivery cursor is inherited.
}

// ---------------------------------------------------------------------------
// Matrix-shape rooms (km-tribe.matrix-shape)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Transcript-based naming — moved to `tribe-wire/lib/transcript`
// (the pure file-reader half; this file keeps the TribeContext-coupled
// `tryInitialRename` below, which imports the readers from the new home).
// ---------------------------------------------------------------------------

/** One-time: if session has a generic member-N name, try to set it from the transcript slug */
export function tryInitialRename(ctx: TribeContext, transcriptPath: string | null): void {
  if (!ctx.getName().startsWith("member-")) return // Already has a real name
  const slug = readTranscriptSlug(transcriptPath)
  if (!slug || slug === ctx.getName()) return

  const existing = ctx.stmts.checkNameTaken.get({ $name: slug, $session_id: ctx.sessionId })
  if (existing) return

  const oldName = ctx.getName()
  ctx.stmts.renameSession.run({ $new_name: slug, $session_id: ctx.sessionId, $now: Date.now() })
  ctx.setName(slug)
  sendMessage(ctx, "*", `Member "${oldName}" is now "${slug}"`, "notify")
  logEvent(ctx, "session.renamed", undefined, { old_name: oldName, new_name: slug, source: "initial-slug" })
  log.info?.(`initial name from /rename: ${oldName} → ${slug}`)
}

// ---------------------------------------------------------------------------
// Runtime-rename persistence (@ag/tribe/21454)
// ---------------------------------------------------------------------------

/**
 * Write an explicitly chosen session name through to the persisted rename
 * authority (`launch_renames`), keyed by the session's launch identity. Called
 * on every successful tribe.rename / explicit tribe.join, so registration can
 * re-apply the name after a daemon restart or transport reconnect — the
 * adapter's register params carry the frozen SPAWN-TIME name, and without this
 * record every re-register silently reverted a runtime rename (the three
 * chief-rename losses of 2026-07-17).
 *
 * A session without a launch identity (legacy transports, ad hoc CLI drains)
 * has no durable key to re-apply against — nothing is persisted, and its
 * renames stay connection-scoped exactly as before. That is the contract, not
 * a fallback.
 */
export function persistRuntimeRename(ctx: TribeContext, name: string): void {
  const row = ctx.db
    .prepare("SELECT launch_id, launch_parent_pid FROM sessions WHERE id = $id")
    .get({ $id: ctx.sessionId }) as { launch_id: string | null; launch_parent_pid: number | null } | null
  if (!row?.launch_id || !row.launch_parent_pid) return
  ctx.stmts.upsertLaunchRename.run({
    $launch_id: row.launch_id,
    $launch_parent_pid: row.launch_parent_pid,
    $name: name,
    $now: Date.now(),
  })
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/** Archive old messages before trimming the hot log. `event_log` was merged
 *  into `messages WHERE kind='event'` by migration v8, so this retention path
 *  covers both direct/broadcast traffic and journal events. */
export function cleanupOldData(ctx: TribeContext): void {
  const SHORT_TTL = 7 * 24 * 60 * 60 * 1000 // 7 days
  const now_ms = Date.now()
  const cutoff = now_ms - SHORT_TTL

  const archived = ctx.stmts.archiveExpiredMessages.run({ $cutoff: cutoff, $archived_at: now_ms })
  const msgsDel = ctx.stmts.deleteExpiredMessages.run({ $cutoff: cutoff })
  // Clean short-lived poll/event dedup keys older than 1 day. The prepared
  // statement preserves durable authority namespaces such as launch takeover.
  ctx.stmts.cleanupDedup.run({ $cutoff: now_ms - 24 * 60 * 60 * 1000 })
  // Ball-tracker GC (@km/tribe/20008): a pending request that never got a reply
  // would otherwise stay "open" forever and pollute tribe.pending. Tie the GC to
  // the SAME cutoff as message retention — a ball never outlives the message that
  // opened it. Fresh request/reply balls (well within 7d) are untouched. Each
  // stale row gets a recoverable gc-expired journal fact before active ownership
  // is removed; source message history remains subject only to normal retention.
  const pendingDel = ctx.db.transaction(() => {
    const rows = ctx.stmts.selectPendingSettlementsBefore.all({ $cutoff: cutoff }) as PendingSettlementRow[]
    return settlePendingRows(ctx, rows, "gc-expired", "daemon", now_ms)
  })()
  // Runtime-rename authority GC (21454): a launch id is minted per seat launch
  // and never reused, so records for long-dead launches are inert. 30 days
  // comfortably outlives any seat; the table stays a handful of rows.
  ctx.stmts.gcOldLaunchRenames.run({ $cutoff: now_ms - 30 * 24 * 60 * 60 * 1000 })

  if ((msgsDel.changes ?? 0) > 0 || pendingDel > 0) {
    log.info?.(
      `cleanup: ${archived.changes ?? 0} msgs archived, ${msgsDel.changes ?? 0} msgs deleted, ${pendingDel} stale pending balls GC'd`,
    )
  }
}
