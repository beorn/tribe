/**
 * Canonical Tribe retrospective report generator.
 *
 * Both the wire CLI and daemon RPC pass their database handle through this
 * pure analysis/formatting core, so response metrics cannot drift by surface.
 */

import type { Database } from "bun:sqlite"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DURATION_MULTIPLIERS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }

/** Parse a duration string like "2h", "30m", "1d" into milliseconds */
export function parseDuration(s: string): number {
  const match = s.match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/)
  if (!match) throw new Error(`Invalid duration: "${s}" — use e.g. "2h", "30m", "1d"`)
  return parseFloat(match[1]!) * DURATION_MULTIPLIERS[match[2]!]!
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
  }>
  timeline: Array<{ time: string; event: string }>
  coordination: {
    /** Balls opened in the window that never received a matching reply. */
    unanswered_queries: number
    avg_response_time: string | null
    response_p50: string | null
    response_p90: string | null
    longest_response: string | null
    longest_response_member: string | null
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

function getOrCreateMember(map: Map<string, MemberMetrics>, name: string): MemberMetrics {
  let m = map.get(name)
  if (!m) {
    m = makeMember(name, "unknown", [])
    map.set(name, m)
  }
  return m
}

/**
 * Ball-tracker response latencies. A message with `request` set opens a tracked
 * ball at its `ts` (== pending_request.opened_at); a later message whose `reply`
 * equals that request id closes it, and that closer (reply.sender) is the
 * responder. Latency = reply.ts − request.ts, attributed to the responder — the
 * same request→reply join the health cadence uses (health-cadence.ts).
 *
 * NO SILENT ERRORS: an opened ball with no matching reply is returned in
 * `openRequestIds` (minus `answeredRequestIds`) and counted as OPEN — never
 * scored as a 0ms response. A reply whose opening request fell outside the
 * loaded window has no known opened_at here, so it is skipped rather than timed
 * against a fabricated start.
 */
function computeResponseTimes(messages: Message[]): {
  latenciesByResponder: Map<string, number[]>
  answeredRequestIds: Set<string>
  openRequestIds: Set<string>
} {
  const latenciesByResponder = new Map<string, number[]>()
  const answeredRequestIds = new Set<string>()
  const openRequestIds = new Set<string>()
  const openedAt = new Map<string, number>()

  for (const msg of messages) {
    if (msg.request) {
      openRequestIds.add(msg.request)
      // The opening send is authoritative; keep the earliest ts if duplicated.
      const prior = openedAt.get(msg.request)
      if (prior === undefined || msg.ts < prior) openedAt.set(msg.request, msg.ts)
    }
  }
  for (const msg of messages) {
    if (!msg.reply) continue
    const openTs = openedAt.get(msg.reply)
    if (openTs === undefined) continue // opener outside window — cannot time it
    if (msg.ts < openTs) continue // out-of-order / clock skew — never a negative latency
    answeredRequestIds.add(msg.reply)
    const arr = latenciesByResponder.get(msg.sender) ?? []
    arr.push(msg.ts - openTs)
    latenciesByResponder.set(msg.sender, arr)
  }
  return { latenciesByResponder, answeredRequestIds, openRequestIds }
}

export function generateRetro(db: Database, sinceMs?: number): RetroReport {
  const now = Date.now()
  const windowStart = sinceMs ? now - sinceMs : getEarliestTimestamp(db)
  const windowEnd = now

  // Regular messages only — event rows live in the same table (kind='event')
  // but are handled separately in the timeline section below.
  const messages = db
    .prepare("SELECT * FROM messages WHERE ts >= ? AND kind != 'event' ORDER BY ts ASC")
    .all(windowStart) as Message[]
  const sessions = db
    .prepare("SELECT * FROM sessions WHERE started_at <= ? AND updated_at >= ?")
    .all(windowEnd, windowStart) as Session[]

  // Include sessions that sent messages but might have expired
  const sessionNames = new Set(sessions.map((s) => s.name))
  for (const sender of new Set(messages.map((m) => m.sender))) {
    if (!sessionNames.has(sender)) {
      const s = db.prepare("SELECT * FROM sessions WHERE name = ?").get(sender) as Session | null
      if (s) {
        sessions.push(s)
        sessionNames.add(s.name)
      }
    }
  }

  // Initialize per-member metrics from sessions
  const memberMap = new Map<string, MemberMetrics>()
  for (const s of sessions) memberMap.set(s.name, makeMember(s.name, s.role, JSON.parse(s.domains) as string[]))

  // Count messages and extract beads
  const byType: Record<string, number> = {}
  for (const msg of messages) {
    byType[msg.type] = (byType[msg.type] ?? 0) + 1
    const sender = getOrCreateMember(memberMap, msg.sender)
    sender.sent++
    sender.byType[msg.type] = (sender.byType[msg.type] ?? 0) + 1
    if (msg.bead_id) sender.beads.add(msg.bead_id)
    const beadRefs = msg.content.match(/\bkm-[\w.-]+/g)
    if (beadRefs) for (const ref of beadRefs) sender.beads.add(ref)

    if (msg.recipient === "*") {
      for (const [name, m] of memberMap) {
        if (name !== msg.sender) m.received++
      }
    } else {
      getOrCreateMember(memberMap, msg.recipient).received++
    }
  }

  // Response latencies (ball-tracker request→reply pairs)
  const { latenciesByResponder, answeredRequestIds, openRequestIds } = computeResponseTimes(messages)
  for (const [name, latencies] of latenciesByResponder) {
    const member = memberMap.get(name)
    if (member) member.responseLatenciesMs = latencies
  }

  const unansweredQueries = [...openRequestIds].filter((id) => !answeredRequestIds.has(id)).length
  const allLatencies = [...latenciesByResponder.values()].flat().sort((a, b) => a - b)
  const avgResponseTime = mean(allLatencies)
  const longestResponse = allLatencies.length > 0 ? allLatencies.at(-1)! : null
  let longestResponseMember: string | null = null
  if (longestResponse !== null) {
    for (const [name, t] of latenciesByResponder)
      if (t.includes(longestResponse)) {
        longestResponseMember = name
        break
      }
  }

  // Timeline: events + notable messages. Events now live in `messages` with
  // type `event.<orig-type>`, sender = session name, content = JSON data.
  const timeline: Array<{ time: string; event: string; ts: number }> = []
  const events = db
    .prepare("SELECT type, sender, content, ts FROM messages WHERE kind = 'event' AND ts >= ? ORDER BY ts ASC")
    .all(windowStart) as Array<{
    type: string
    sender: string
    content: string
    ts: number
  }>

  const eventFormatters: Record<string, (ev: (typeof events)[0], data: Record<string, string>) => string | null> = {
    "session.joined": (ev, data) => `${ev.sender} joined (${data.role ?? "member"})`,
    "session.left": (ev) => `${ev.sender} left`,
    "session.renamed": (_, data) => `${data.old_name} renamed to ${data.new_name}`,
    "message.broadcast": (ev) => `${ev.sender} broadcast a message`,
  }
  for (const ev of events) {
    const origType = ev.type.slice("event.".length)
    const fmt = eventFormatters[origType]
    if (fmt) {
      const text = fmt(ev, (ev.content ? JSON.parse(ev.content) : {}) as Record<string, string>)
      if (text) timeline.push({ time: formatTime(ev.ts), event: text, ts: ev.ts })
    }
  }

  const msgFormatters: Record<string, (msg: Message) => string> = {
    assign: (m) => `${m.sender} assigned to ${m.recipient}: ${snippet(m.content)}`,
    request: (m) => `${m.sender} requested from ${m.recipient}: ${snippet(m.content)}`,
    verdict: (m) => `${m.recipient} received verdict: ${snippet(m.content)}`,
  }
  for (const msg of messages) {
    const fmt = msgFormatters[msg.type]
    if (fmt) timeline.push({ time: formatTime(msg.ts), event: fmt(msg), ts: msg.ts })
  }
  timeline.sort((a, b) => a.ts - b.ts)

  const memberList = [...memberMap.values()]
    .filter((m) => m.sent > 0 || m.received > 0)
    .sort((a, b) => b.sent - a.sent)
    .map((m) => {
      const sorted = [...m.responseLatenciesMs].sort((a, b) => a - b)
      return {
        name: m.name,
        role: m.role,
        domains: m.domains,
        sent: m.sent,
        received: m.received,
        beads_mentioned: [...m.beads].sort(),
        responses: sorted.length,
        avg_response: durationOrNull(mean(sorted)),
        response_p50: durationOrNull(percentile(sorted, 0.5)),
        response_p90: durationOrNull(percentile(sorted, 0.9)),
      }
    })

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
    timeline: timeline.map(({ time, event }) => ({ time, event })),
    coordination: {
      unanswered_queries: unansweredQueries,
      avg_response_time: durationOrNull(avgResponseTime),
      response_p50: durationOrNull(percentile(allLatencies, 0.5)),
      response_p90: durationOrNull(percentile(allLatencies, 0.9)),
      longest_response: durationOrNull(longestResponse),
      longest_response_member: longestResponseMember,
    },
  }
}

function getEarliestTimestamp(db: Database): number {
  const row = db.prepare("SELECT MIN(ts) as min_ts FROM messages").get() as { min_ts: number | null } | null
  if (row?.min_ts) return row.min_ts
  const session = db.prepare("SELECT MIN(started_at) as min_ts FROM sessions").get() as { min_ts: number | null } | null
  return session?.min_ts ?? Date.now()
}

// ---------------------------------------------------------------------------
// Markdown formatter
// ---------------------------------------------------------------------------

export function formatMarkdown(report: RetroReport): string {
  const lines: string[] = []
  lines.push(`# Tribe Retro — ${formatDate(report.window.start)}`, "")
  lines.push("## Summary")
  lines.push(`- Duration: ${report.summary.duration}`)
  lines.push(`- Members: ${report.summary.members} active (${report.members.map((m) => m.name).join(", ")})`)
  const typeBreakdown = Object.entries(report.summary.by_type)
    .map(([t, c]) => `${c} ${t}`)
    .join(", ")
  lines.push(`- Messages: ${report.summary.total_messages} total (${typeBreakdown})`, "")

  if (report.members.length > 0) {
    lines.push("## Per-Member Activity")
    lines.push("| Member | Sent | Received | Beads Mentioned | Responses | Avg Response | p50 | p90 |")
    lines.push("|--------|------|----------|-----------------|-----------|--------------|-----|-----|")
    for (const m of report.members)
      lines.push(
        `| ${m.name} | ${m.sent} | ${m.received} | ${m.beads_mentioned.length} | ${m.responses} | ${m.avg_response ?? "—"} | ${m.response_p50 ?? "—"} | ${m.response_p90 ?? "—"} |`,
      )
    lines.push("")
  }

  if (report.timeline.length > 0) {
    lines.push("## Timeline")
    for (const ev of report.timeline) lines.push(`- ${ev.time} — ${ev.event}`)
    lines.push("")
  }

  lines.push("## Coordination Health")
  lines.push(`- Unanswered queries: ${report.coordination.unanswered_queries}`)
  lines.push(`- Average response time: ${report.coordination.avg_response_time ?? "—"}`)
  if (report.coordination.response_p50 || report.coordination.response_p90)
    lines.push(
      `- Response p50 / p90: ${report.coordination.response_p50 ?? "—"} / ${report.coordination.response_p90 ?? "—"}`,
    )
  if (report.coordination.longest_response)
    lines.push(
      `- Longest response: ${report.coordination.longest_response} (${report.coordination.longest_response_member})`,
    )
  lines.push("")
  return lines.join("\n")
}
