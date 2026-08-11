/**
 * Canonical Tribe retrospective report generator.
 *
 * Both the wire CLI and daemon RPC pass their database handle through this
 * pure analysis/formatting core, so response metrics cannot drift by surface.
 */

import { TRIBE_AUTO_TRACK_TYPES } from "../command-descriptors.ts"
import {
  parseBallOutcomeFact,
  type BallOutcomeFactRow,
  type BallSettlementFact,
  type BallSettlementReason,
} from "./ball-outcome.ts"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DURATION_MULTIPLIERS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }

type SqlBinding = string | number | bigint | boolean | null | Uint8Array
interface RetroDatabase {
  prepare(sql: string): {
    all(...bindings: SqlBinding[]): unknown[]
    get(...bindings: SqlBinding[]): unknown
  }
}

/** Parse a duration string like "2h", "30m", "1d" into milliseconds */
export function parseDuration(s: string): number {
  const match = s.match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/)
  if (!match) throw new Error(`Invalid duration: "${s}" — use e.g. "2h", "30m", "1d"`)
  const amount = match[1]
  const unit = match[2]
  const multiplier = unit === undefined ? undefined : DURATION_MULTIPLIERS[unit]
  if (amount === undefined || multiplier === undefined) throw new Error(`Invalid duration: "${s}"`)
  return parseFloat(amount) * multiplier
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s`
  if (ms < 3_600_000) {
    const m = Math.floor(ms / 60_000)
    const s = Math.round((ms % 60_000) / 1_000)
    return s > 0 ? `${m}m ${s}s` : `${m}m`
  }
  const h = Math.floor(ms / 3_600_000)
  const m = Math.round((ms % 3_600_000) / 60_000)
  return m > 0 ? `${h}h ${m}m` : `${h}h`
}

const formatTime = (ts: number) =>
  new Date(ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })
const formatDate = (ts: number) => new Date(ts).toISOString().slice(0, 10)
const snippet = (s: string, n = 80) => (s.length > n ? s.slice(0, n) + "..." : s)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Message {
  id: string
  type: string
  sender: string
  recipient: string
  content: string
  bead_id: string | null
  ref: string | null
  /** Set when this message OPENS a tracked ball (== pending_request.request_id). */
  request: string | null
  /** Set when this message CLOSES a tracked ball; value is the request id it answers. */
  reply: string | null
  summary: string | null
  correlated_reply_requester: string | null
  ts: number
}

interface Session {
  id: string
  name: string
  role: string
  domains: string
  started_at: number
  updated_at: number
}

interface MemberMetrics {
  name: string
  role: string
  domains: string[]
  sent: number
  received: number
  byType: Record<string, number>
  beads: Set<string>
  /** Latencies (ms) of balls THIS member answered, i.e. reply.ts − request.ts. */
  responseLatenciesMs: number[]
}

type SettlementCounts = Record<BallSettlementReason, number>
type BallEndings = SettlementCounts & { open: number; unknown: number }

interface BallMetricsReport {
  arrivals: number
  answers: number
  answer_share: number | null
  response_p50: string | null
  response_p90: string | null
  response_max: string | null
  endings: BallEndings
  oldest_unanswered: string | null
  /** Free-text semantics require the supervised daily reviewer. Null is honest, not zero. */
  default_acceptance: null
}

interface BallReviewEntry {
  request_id: string
  owner: string
  request: { id: string; sender: string; content: string; summary: string | null; ts: number }
  reply: { id: string; sender: string; content: string; summary: string | null; ts: number } | null
  ending: BallSettlementReason | "open" | "unknown"
  default_acceptance: null
}

export interface RetroReport {
  generated_at: string
  window: { start: number; end: number; duration_ms: number }
  summary: { duration: string; members: number; total_messages: number; by_type: Record<string, number> }
  members: Array<{
    name: string
    role: string
    domains: string[]
    sent: number
    received: number
    beads_mentioned: string[]
    /** Number of balls this member answered (denominator of the averages). */
    responses: number
    avg_response: string | null
    response_p50: string | null
    response_p90: string | null
    balls: BallMetricsReport
  }>
  unattributed_activity: { messages: number; distinct_endpoints: number }
  /** Lossless content seam for the supervised daily classifier. */
  review_corpus: BallReviewEntry[]
  timeline: Array<{ time: string; event: string }>
  coordination: {
    /** Balls opened in the window that never received a matching reply. */
    unanswered_queries: number
    avg_response_time: string | null
    response_p50: string | null
    response_p90: string | null
    longest_response: string | null
    longest_response_member: string | null
    /** Read-derived terminal outcomes. Deadline observations are not settlements. */
    settlements: SettlementCounts
  }
}

// ---------------------------------------------------------------------------
// Core analysis
// ---------------------------------------------------------------------------

function makeMember(name: string, role: string, domains: string[]): MemberMetrics {
  return { name, role, domains, sent: 0, received: 0, byType: {}, beads: new Set(), responseLatenciesMs: [] }
}

/** Nearest-rank percentile over an ascending-sorted array (matches health-cadence). */
function percentile(sortedAsc: number[], fraction: number): number | null {
  if (sortedAsc.length === 0) return null
  return sortedAsc[Math.max(0, Math.ceil(sortedAsc.length * fraction) - 1)] ?? null
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null
  return values.reduce((a, b) => a + b, 0) / values.length
}

const durationOrNull = (ms: number | null): string | null => (ms !== null ? formatDuration(ms) : null)

const emptySettlementCounts = (): SettlementCounts => ({
  answered: 0,
  "manual-close": 0,
  "incident-cleared": 0,
  "gc-expired": 0,
  "sender-withdrawn": 0,
})

const emptyBallEndings = (): BallEndings => ({ ...emptySettlementCounts(), open: 0, unknown: 0 })

interface PendingBallRow {
  request_id: string
  recipient: string
  sender: string
  opened_at: number
  message_id: string
}

interface BallRecord {
  requestId: string
  owner: string
  openedAt: number
  messageId: string
  opener: Message | null
  reply: Message | null
  ending: BallSettlementReason | "open" | "unknown"
  latencyMs: number | null
}

function ballIdentity(requestId: string, owner: string, messageId: string): string {
  return JSON.stringify([requestId, owner, messageId])
}

function deriveBallAnalysis(db: RetroDatabase, messages: Message[], windowStart: number, now: number) {
  const records = new Map<string, BallRecord>()
  const messageById = new Map(messages.map((message) => [message.id, message]))
  const autoTrackedTypes: ReadonlySet<string> = new Set(TRIBE_AUTO_TRACK_TYPES)
  const openers = messages.filter(
    (message): message is Message & { request: string } =>
      message.request !== null && message.recipient !== "*" && autoTrackedTypes.has(message.type),
  )
  for (const opener of openers) {
    records.set(ballIdentity(opener.request, opener.recipient, opener.id), {
      requestId: opener.request,
      owner: opener.recipient,
      openedAt: opener.ts,
      messageId: opener.id,
      opener,
      reply: null,
      ending: "unknown",
      latencyMs: null,
    })
  }

  const settlements = new Map<string, BallSettlementFact>()
  const settlementRows = db
    .prepare(
      "SELECT id, type, content, ts FROM messages WHERE kind = 'event' AND type = 'event.ball.settled' AND ts >= ?",
    )
    .all(windowStart) as BallOutcomeFactRow[]
  for (const row of settlementRows) {
    const fact = parseBallOutcomeFact(row)
    if (fact.kind !== "settled") throw new Error(`expected ball settlement fact ${row.id}`)
    if (fact.opened_at < windowStart) continue
    const key = ballIdentity(fact.request_id, fact.recipient, fact.message_id)
    const prior = settlements.get(key)
    if (prior !== undefined && prior.settlement !== fact.settlement) {
      throw new Error(
        `conflicting ball settlement facts for ${fact.request_id}: ${prior.settlement} vs ${fact.settlement}`,
      )
    }
    settlements.set(key, fact)
    if (!records.has(key)) {
      records.set(key, {
        requestId: fact.request_id,
        owner: fact.recipient,
        openedAt: fact.opened_at,
        messageId: fact.message_id,
        opener: messageById.get(fact.message_id) ?? null,
        reply: null,
        ending: fact.settlement,
        latencyMs: fact.settlement === "answered" ? fact.settled_at - fact.opened_at : null,
      })
    }
  }

  const pendingRows = db
    .prepare(
      "SELECT request_id, recipient, sender, opened_at, message_id FROM pending_request WHERE opened_at >= ? AND opened_at <= ?",
    )
    .all(windowStart, now) as PendingBallRow[]
  const pendingKeys = new Set(pendingRows.map((row) => ballIdentity(row.request_id, row.recipient, row.message_id)))
  for (const row of pendingRows) {
    const key = ballIdentity(row.request_id, row.recipient, row.message_id)
    if (!records.has(key)) {
      records.set(key, {
        requestId: row.request_id,
        owner: row.recipient,
        openedAt: row.opened_at,
        messageId: row.message_id,
        opener: messageById.get(row.message_id) ?? null,
        reply: null,
        ending: "open",
        latencyMs: null,
      })
    }
  }

  const repliesByReference = new Map<string, Message[]>()
  for (const message of messages) {
    if (message.reply === null) continue
    const replies = repliesByReference.get(message.reply) ?? []
    replies.push(message)
    repliesByReference.set(message.reply, replies)
  }
  const matchingReply = (record: BallRecord): Message | null => {
    const candidates =
      record.requestId === record.messageId
        ? (repliesByReference.get(record.requestId) ?? [])
        : [...(repliesByReference.get(record.requestId) ?? []), ...(repliesByReference.get(record.messageId) ?? [])]
    return (
      candidates.find(
        (reply) =>
          reply.sender === record.owner &&
          (record.opener === null || reply.recipient === record.opener.sender) &&
          (reply.correlated_reply_requester === null ||
            record.opener === null ||
            reply.correlated_reply_requester === record.opener.sender),
      ) ?? null
    )
  }
  for (const [key, record] of records) {
    const settlement = settlements.get(key)
    if (settlement !== undefined) {
      record.ending = settlement.settlement
      record.latencyMs = settlement.settlement === "answered" ? settlement.settled_at - record.openedAt : null
      record.reply = matchingReply(record)
      continue
    }
    if (pendingKeys.has(key)) {
      record.ending = "open"
      continue
    }
    const reply = matchingReply(record)
    if (reply !== null && reply.ts >= record.openedAt) {
      record.reply = reply
      record.ending = "answered"
      record.latencyMs = reply.ts - record.openedAt
    }
  }

  const byOwner = new Map<string, BallRecord[]>()
  for (const record of records.values()) {
    const ownerRecords = byOwner.get(record.owner) ?? []
    ownerRecords.push(record)
    byOwner.set(record.owner, ownerRecords)
  }
  const metricsByOwner = new Map<string, BallMetricsReport>()
  for (const [owner, ownerRecords] of byOwner) {
    const endings = emptyBallEndings()
    const latencies = ownerRecords
      .flatMap((record) => (record.ending === "answered" && record.latencyMs !== null ? [record.latencyMs] : []))
      .sort((left, right) => left - right)
    for (const record of ownerRecords) endings[record.ending] += 1
    const openAges = ownerRecords.filter((record) => record.ending === "open").map((record) => now - record.openedAt)
    metricsByOwner.set(owner, {
      arrivals: ownerRecords.length,
      answers: endings.answered,
      answer_share: ownerRecords.length === 0 ? null : endings.answered / ownerRecords.length,
      response_p50: durationOrNull(percentile(latencies, 0.5)),
      response_p90: durationOrNull(percentile(latencies, 0.9)),
      response_max: durationOrNull(latencies.at(-1) ?? null),
      endings,
      oldest_unanswered: durationOrNull(openAges.length === 0 ? null : Math.max(...openAges)),
      default_acceptance: null,
    })
  }

  const reviewCorpus = [...records.values()]
    .filter((record): record is BallRecord & { opener: Message } => record.opener !== null)
    .sort((left, right) => left.openedAt - right.openedAt)
    .map(
      (record): BallReviewEntry => ({
        request_id: record.requestId,
        owner: record.owner,
        request: {
          id: record.opener.id,
          sender: record.opener.sender,
          content: record.opener.content,
          summary: record.opener.summary,
          ts: record.opener.ts,
        },
        reply:
          record.reply === null
            ? null
            : {
                id: record.reply.id,
                sender: record.reply.sender,
                content: record.reply.content,
                summary: record.reply.summary,
                ts: record.reply.ts,
              },
        ending: record.ending,
        default_acceptance: null,
      }),
    )
  return { records: [...records.values()], metricsByOwner, reviewCorpus }
}

function collectMemberActivity(messages: Message[], sessions: Session[]) {
  const memberMap = new Map<string, MemberMetrics>()
  for (const session of sessions) {
    memberMap.set(session.name, makeMember(session.name, session.role, JSON.parse(session.domains) as string[]))
  }
  const byType: Record<string, number> = {}
  const unattributedEndpoints = new Set<string>()
  let unattributedMessages = 0
  for (const message of messages) {
    byType[message.type] = (byType[message.type] ?? 0) + 1
    const sender = memberMap.get(message.sender)
    if (sender !== undefined) {
      sender.sent++
      sender.byType[message.type] = (sender.byType[message.type] ?? 0) + 1
      if (message.bead_id) sender.beads.add(message.bead_id)
      const beadRefs = message.content.match(/\bkm-[\w.-]+/g)
      if (beadRefs) for (const ref of beadRefs) sender.beads.add(ref)
    }
    if (message.recipient === "*") {
      for (const [name, member] of memberMap) {
        if (name !== message.sender) member.received++
      }
    } else {
      const recipient = memberMap.get(message.recipient)
      if (recipient !== undefined) recipient.received++
    }
    const unknown = [message.sender, ...(message.recipient === "*" ? [] : [message.recipient])].filter(
      (endpoint) => !memberMap.has(endpoint),
    )
    if (unknown.length > 0) {
      unattributedMessages++
      for (const endpoint of unknown) unattributedEndpoints.add(endpoint)
    }
  }
  return { memberMap, byType, unattributedMessages, unattributedEndpoints }
}

function emptyBallMetrics(): BallMetricsReport {
  return {
    arrivals: 0,
    answers: 0,
    answer_share: null,
    response_p50: null,
    response_p90: null,
    response_max: null,
    endings: emptyBallEndings(),
    oldest_unanswered: null,
    default_acceptance: null,
  }
}

function projectMembers(
  memberMap: ReadonlyMap<string, MemberMetrics>,
  ballAnalysis: ReturnType<typeof deriveBallAnalysis>,
): RetroReport["members"] {
  return [...memberMap.values()]
    .filter((member) => member.sent > 0 || member.received > 0)
    .sort((left, right) => right.sent - left.sent)
    .map((member) => {
      const sorted = [...member.responseLatenciesMs].sort((left, right) => left - right)
      return {
        name: member.name,
        role: member.role,
        domains: member.domains,
        sent: member.sent,
        received: member.received,
        beads_mentioned: [...member.beads].sort(),
        responses: sorted.length,
        avg_response: durationOrNull(mean(sorted)),
        response_p50: durationOrNull(percentile(sorted, 0.5)),
        response_p90: durationOrNull(percentile(sorted, 0.9)),
        balls: ballAnalysis.metricsByOwner.get(member.name) ?? emptyBallMetrics(),
      }
    })
}

function buildTimeline(
  db: RetroDatabase,
  messages: Message[],
  windowStart: number,
): Array<{ time: string; event: string; ts: number }> {
  const timeline: Array<{ time: string; event: string; ts: number }> = []
  const events = db
    .prepare("SELECT type, sender, content, ts FROM messages WHERE kind = 'event' AND ts >= ? ORDER BY ts ASC")
    .all(windowStart) as Array<{ type: string; sender: string; content: string; ts: number }>
  const eventFormatters: Record<string, (event: (typeof events)[0], data: Record<string, string>) => string | null> = {
    "session.joined": (event, data) => `${event.sender} joined (${data.role ?? "member"})`,
    "session.left": (event) => `${event.sender} left`,
    "session.renamed": (_, data) => `${data.old_name} renamed to ${data.new_name}`,
    "message.broadcast": (event) => `${event.sender} broadcast a message`,
  }
  for (const event of events) {
    const formatter = eventFormatters[event.type.slice("event.".length)]
    if (formatter === undefined) continue
    const text = formatter(event, (event.content ? JSON.parse(event.content) : {}) as Record<string, string>)
    if (text) timeline.push({ time: formatTime(event.ts), event: text, ts: event.ts })
  }
  const messageFormatters: Record<string, (message: Message) => string> = {
    assign: (message) => `${message.sender} assigned to ${message.recipient}: ${snippet(message.content)}`,
    request: (message) => `${message.sender} requested from ${message.recipient}: ${snippet(message.content)}`,
    verdict: (message) => `${message.recipient} received verdict: ${snippet(message.content)}`,
  }
  for (const message of messages) {
    const formatter = messageFormatters[message.type]
    if (formatter) timeline.push({ time: formatTime(message.ts), event: formatter(message), ts: message.ts })
  }
  timeline.sort((left, right) => left.ts - right.ts)
  return timeline
}

function deriveCoordination(ballAnalysis: ReturnType<typeof deriveBallAnalysis>) {
  const settlements = emptySettlementCounts()
  for (const record of ballAnalysis.records) {
    if (record.ending in settlements) settlements[record.ending as BallSettlementReason] += 1
  }
  const unansweredQueries = ballAnalysis.records.filter(
    (record) => record.ending === "open" || record.ending === "unknown",
  ).length
  const allLatencies = ballAnalysis.records
    .flatMap((record) => (record.ending === "answered" && record.latencyMs !== null ? [record.latencyMs] : []))
    .sort((left, right) => left - right)
  const longestResponse = allLatencies.at(-1) ?? null
  const longestResponseMember =
    longestResponse === null
      ? null
      : (ballAnalysis.records.find((record) => record.latencyMs === longestResponse)?.owner ?? null)
  return { settlements, unansweredQueries, allLatencies, longestResponse, longestResponseMember }
}

export function generateRetro(db: RetroDatabase, sinceMs?: number): RetroReport {
  const now = Date.now()
  const windowStart = sinceMs ? now - sinceMs : getEarliestTimestamp(db)
  const windowEnd = now

  // Regular messages only — event rows live in the same table (kind='event')
  // but are handled separately in the timeline section below.
  const messages = db
    .prepare("SELECT * FROM messages WHERE ts >= ? AND kind != 'event' ORDER BY ts ASC")
    .all(windowStart) as Message[]
  const endpointNames = new Set(messages.flatMap((message) => [message.sender, message.recipient]))
  // A journal endpoint string is not a person. Only durable session evidence
  // can admit a named member; transport placeholders and retired names stay in
  // one unattributed aggregate instead of inflating the roster.
  const sessions = (db.prepare("SELECT * FROM sessions ORDER BY updated_at ASC").all() as Session[]).filter(
    (session) =>
      (session.started_at <= windowEnd && session.updated_at >= windowStart) || endpointNames.has(session.name),
  )

  const { memberMap, byType, unattributedMessages, unattributedEndpoints } = collectMemberActivity(messages, sessions)

  const ballAnalysis = deriveBallAnalysis(db, messages, windowStart, now)
  for (const name of ballAnalysis.metricsByOwner.keys()) {
    const member = memberMap.get(name)
    if (member !== undefined) {
      const records = ballAnalysis.records.filter((record) => record.owner === name)
      member.responseLatenciesMs = records.flatMap((record) =>
        record.ending === "answered" && record.latencyMs !== null ? [record.latencyMs] : [],
      )
    }
  }

  const { settlements, unansweredQueries, allLatencies, longestResponse, longestResponseMember } =
    deriveCoordination(ballAnalysis)
  const avgResponseTime = mean(allLatencies)
  const timeline = buildTimeline(db, messages, windowStart)
  const memberList = projectMembers(memberMap, ballAnalysis)

  const durationMs = windowEnd - windowStart
  return {
    generated_at: new Date().toISOString(),
    window: { start: windowStart, end: windowEnd, duration_ms: durationMs },
    summary: {
      duration: formatDuration(durationMs),
      members: memberList.length,
      total_messages: messages.length,
      by_type: byType,
    },
    members: memberList,
    unattributed_activity: {
      messages: unattributedMessages,
      distinct_endpoints: unattributedEndpoints.size,
    },
    review_corpus: ballAnalysis.reviewCorpus,
    timeline: timeline.map(({ time, event }) => ({ time, event })),
    coordination: {
      unanswered_queries: unansweredQueries,
      avg_response_time: durationOrNull(avgResponseTime),
      response_p50: durationOrNull(percentile(allLatencies, 0.5)),
      response_p90: durationOrNull(percentile(allLatencies, 0.9)),
      longest_response: durationOrNull(longestResponse),
      longest_response_member: longestResponseMember,
      settlements,
    },
  }
}

function getEarliestTimestamp(db: RetroDatabase): number {
  const row = db.prepare("SELECT MIN(ts) as min_ts FROM messages").get() as { min_ts: number | null } | null
  if (row?.min_ts) return row.min_ts
  const session = db.prepare("SELECT MIN(started_at) as min_ts FROM sessions").get() as { min_ts: number | null } | null
  return session?.min_ts ?? Date.now()
}

// ---------------------------------------------------------------------------
// Markdown formatter
// ---------------------------------------------------------------------------

export function formatMarkdown(report: RetroReport): string {
  const TIMELINE_LIMIT = 10
  const lines: string[] = []
  lines.push(`# Tribe Retro — ${formatDate(report.window.start)}`, "")
  lines.push("## Summary")
  lines.push(`- Duration: ${report.summary.duration}`)
  lines.push(`- Members: ${report.summary.members} active (${report.members.map((m) => m.name).join(", ")})`)
  const typeBreakdown = Object.entries(report.summary.by_type)
    .map(([t, c]) => `${c} ${t}`)
    .join(", ")
  lines.push(`- Messages: ${report.summary.total_messages} total (${typeBreakdown})`, "")
  if (report.unattributed_activity.messages > 0) {
    lines.push(
      `- Unattributed transport activity: ${report.unattributed_activity.messages} messages across ${report.unattributed_activity.distinct_endpoints} endpoints`,
      "",
    )
  }

  if (report.members.length > 0) {
    lines.push("## Per-Seat Ball Reliability")
    lines.push("| Seat | Arrivals | Answers | Share | p50 | p90 | Max | Open | Oldest | Other endings |")
    lines.push("|------|----------|---------|-------|-----|-----|-----|------|--------|---------------|")
    for (const m of report.members) {
      const share = m.balls.answer_share === null ? "—" : `${Math.round(m.balls.answer_share * 100)}%`
      const otherEndings = [
        `manual=${m.balls.endings["manual-close"]}`,
        `incident=${m.balls.endings["incident-cleared"]}`,
        `gc=${m.balls.endings["gc-expired"]}`,
        `withdrawn=${m.balls.endings["sender-withdrawn"]}`,
        `unknown=${m.balls.endings.unknown}`,
      ].join(" ")
      lines.push(
        `| ${m.name} | ${m.balls.arrivals} | ${m.balls.answers} | ${share} | ${m.balls.response_p50 ?? "—"} | ${m.balls.response_p90 ?? "—"} | ${m.balls.response_max ?? "—"} | ${m.balls.endings.open} | ${m.balls.oldest_unanswered ?? "—"} | ${otherEndings} |`,
      )
    }
    lines.push("", "Default acceptance: requires supervised review of the correlated corpus; unknown is never zero.")
    lines.push("")
  }

  if (report.timeline.length > 0) {
    lines.push("## Timeline")
    const visible = report.timeline.slice(-TIMELINE_LIMIT)
    const omitted = report.timeline.length - visible.length
    if (omitted > 0) lines.push(`- … ${omitted} older event${omitted === 1 ? "" : "s"} omitted`)
    for (const ev of visible) lines.push(`- ${ev.time} — ${ev.event}`)
    lines.push("")
  }

  lines.push("## Coordination Health")
  lines.push(`- Unanswered queries: ${report.coordination.unanswered_queries}`)
  lines.push(
    `- Settlements: answered=${report.coordination.settlements.answered}, manual-close=${report.coordination.settlements["manual-close"]}, incident-cleared=${report.coordination.settlements["incident-cleared"]}, gc-expired=${report.coordination.settlements["gc-expired"]}, sender-withdrawn=${report.coordination.settlements["sender-withdrawn"]}`,
  )
  if (report.coordination.response_p50 || report.coordination.response_p90) {
    lines.push(
      `- Response p50 / p90: ${report.coordination.response_p50 ?? "—"} / ${report.coordination.response_p90 ?? "—"}`,
    )
  }
  if (report.coordination.longest_response) {
    lines.push(
      `- Response max: ${report.coordination.longest_response} (${report.coordination.longest_response_member})`,
    )
  }
  lines.push(`- Review corpus: ${report.review_corpus.length} tracked arrivals with auditable ids and content`)
  lines.push("")
  return lines.join("\n")
}
