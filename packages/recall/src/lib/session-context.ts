/**
 * session-context.ts — Read the CURRENT Claude Code session transcript.
 *
 * Biggest quality lever for vague queries: the planner needs to know
 * what the user is actually doing right now. "That link thing" is
 * unambiguous if the last 200 lines of conversation show work on
 * storage/links.ts and discussion of host_id/href/rel.
 *
 * Fails silently if no session is active (CI, scripts, cron).
 */

import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { execSync } from "child_process"
import {
  discoverActiveSession,
  renderDiscoveryDiagnostics,
  type SessionDiscoveryDiagnostics,
  type SessionFormat,
} from "./session-discovery.ts"

// ============================================================================
// Types
// ============================================================================

export interface SessionContext {
  sessionId: string
  /** Age of the last message in milliseconds — used to decide if context is fresh. */
  ageMs: number | null
  /** Most recent user+assistant text content, flattened, truncated to maxChars. */
  recentMessages: string
  /** Number of exchanges captured. */
  exchangeCount: number
  /** File paths mentioned in the tail. */
  mentionedPaths: string[]
  /** Bead IDs (km-* pattern) mentioned in the tail. */
  mentionedBeads: string[]
  /** Distinctive tokens (camelCase, snake_case, dotted paths) from the tail. */
  mentionedTokens: string[]
}

// ============================================================================
// Options
// ============================================================================

export interface BuildSessionContextOptions {
  /** Max lines to read from the tail of the JSONL (default 400). */
  tailLines?: number
  /** Max chars to keep from flattened message text (default 6000). */
  maxChars?: number
  /** Max tokens to return in `mentionedTokens` (default 40). */
  maxTokens?: number
  /** Skip session context if the last message is older than this (default 30 min). */
  maxAgeMs?: number
  /** Override session id (for testing). */
  sessionIdOverride?: string
  /** Override cwd (for testing). */
  cwdOverride?: string
  /** Override home dir (for testing). Defaults to os.homedir(). */
  homeOverride?: string
}

/** Why a current-session lookup produced no usable context. */
export type NoSessionReason = "no-candidate" | "unreadable" | "empty" | "stale"

export interface CurrentSessionResolution {
  context: SessionContext | null
  /** Always present — explains what roots were searched and what was chosen. */
  diagnostics: SessionDiscoveryDiagnostics
  /** Set when `context` is null; null when a session was resolved. */
  reason: NoSessionReason | null
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Read the current agent session context.
 * Returns null if no session is active, the file is missing, or the session
 * is stale (> maxAgeMs). For the reason + searched-roots diagnostics, use
 * {@link getCurrentSessionContextWithDiagnostics}.
 */
export function getCurrentSessionContext(opts: BuildSessionContextOptions = {}): SessionContext | null {
  return getCurrentSessionContextWithDiagnostics(opts).context
}

/**
 * Like {@link getCurrentSessionContext} but always returns diagnostics so an
 * empty/wrong-session outcome can be explained loudly (searched roots, chosen
 * path/id, candidate count, freshness, exclusion reasons) instead of failing
 * silently. This is the canonical entry for `recall current-brief`.
 *
 * Detection priority (best → fallback):
 *   1. Explicit override (tests) / CLAUDE_SESSION_ID env var
 *   2. Sentinel file written by the UserPromptSubmit hook, keyed by the
 *      ancestor claude PID — deterministic even with parallel Claude sessions
 *   3. Cross-root discovery — the freshest cwd-matching transcript across
 *      Claude + Codex + ag-profile roots (handles Codex/ag seats the old
 *      Claude-only heuristic silently missed).
 */
export function getCurrentSessionContextWithDiagnostics(
  opts: BuildSessionContextOptions = {},
): CurrentSessionResolution {
  const {
    tailLines = 400,
    maxChars = 6000,
    maxTokens = 40,
    maxAgeMs = 30 * 60_000,
    sessionIdOverride,
    cwdOverride,
    homeOverride,
  } = opts

  const home = homeOverride ?? os.homedir()
  const cwd = cwdOverride ?? process.cwd()
  const now = Date.now()

  // Always run discovery — it gives us both the fallback candidate AND the
  // diagnostics we return on every path (loud, never silent).
  const discovery = discoverActiveSession({ cwd, homeDir: home, now })
  const diagnostics = discovery.diagnostics

  // Priority 1/2: explicit id / env / sentinel (Claude-only resolution).
  let sessionId = sessionIdOverride ?? process.env.CLAUDE_SESSION_ID
  let jsonlPath: string | null = null
  let format: SessionFormat = "claude"
  let via = "discovery"

  if (sessionId) {
    jsonlPath = resolveSessionJsonl(sessionId, cwd, home)
    if (jsonlPath) via = sessionIdOverride ? "override" : "env:CLAUDE_SESSION_ID"
  }
  if (!jsonlPath) {
    const viaSentinel = readSessionSentinel(home)
    if (viaSentinel) {
      sessionId = viaSentinel.sessionId
      jsonlPath = viaSentinel.transcriptPath ?? resolveSessionJsonl(viaSentinel.sessionId, viaSentinel.cwd ?? cwd, home)
      if (jsonlPath) via = "sentinel"
    }
  }
  if (!jsonlPath && discovery.candidate) {
    // Priority 3: cross-root discovery.
    jsonlPath = discovery.candidate.path
    sessionId = discovery.candidate.sessionId
    format = discovery.candidate.format
    via = discovery.candidate.rootKind
  }

  // Keep diagnostics honest: point `chosen` at the session we actually use.
  if (jsonlPath && sessionId) {
    diagnostics.chosen = {
      path: jsonlPath,
      sessionId,
      format,
      rootKind: via,
      ageMs: now - safeMtime(jsonlPath, now),
    }
  }

  if (!jsonlPath || !sessionId) {
    return { context: null, diagnostics, reason: "no-candidate" }
  }

  let lines: string[]
  try {
    lines = readLastLines(jsonlPath, tailLines)
  } catch {
    // silent-fallback-allow: surfaced via diagnostics + reason below.
    return { context: null, diagnostics, reason: "unreadable" }
  }
  if (lines.length === 0) return { context: null, diagnostics, reason: "empty" }

  const messages = extractMessages(lines, format)
  if (messages.length === 0) return { context: null, diagnostics, reason: "empty" }

  const lastTimestamp = findLastTimestamp(lines)
  const ageMs = lastTimestamp !== null ? now - lastTimestamp : null

  // Stale sessions: drop the context but keep diagnostics so the caller can
  // explain "found session X, but it's 45m old (> 30m freshness)".
  if (ageMs !== null && ageMs > maxAgeMs) {
    return { context: null, diagnostics, reason: "stale" }
  }

  // Flatten, keep the TAIL (most recent) within budget
  const flat = messages.map(formatExchange).join("\n\n")
  const recentMessages = flat.length > maxChars ? flat.slice(-maxChars) : flat

  const mentionedPaths = extractPaths(recentMessages)
  const mentionedBeads = extractBeadIds(recentMessages)
  const mentionedTokens = extractTechTokens(recentMessages).slice(0, maxTokens)

  return {
    context: {
      sessionId,
      ageMs,
      recentMessages,
      exchangeCount: messages.length,
      mentionedPaths,
      mentionedBeads,
      mentionedTokens,
    },
    diagnostics,
    reason: null,
  }
}

function safeMtime(filepath: string, fallback: number): number {
  try {
    return fs.statSync(filepath).mtimeMs
  } catch {
    // silent-fallback-allow: missing file → treat as "now" so ageMs reads 0.
    return fallback
  }
}

/**
 * Render a compact, human-friendly summary of the session context.
 * Used by `bun recall current-brief` so the /recall skill can embed
 * it as speculative context before Claude reasons about the query.
 */
export function renderSessionBrief(ctx: SessionContext | null): string {
  if (!ctx) return "(no active agent session — skipping session context)"

  const lines: string[] = []
  const age = ctx.ageMs === null ? "unknown age" : `${Math.round(ctx.ageMs / 60_000)}m ago`
  lines.push(`Session ${ctx.sessionId.slice(0, 8)} — ${age}, ${ctx.exchangeCount} recent exchanges`)

  if (ctx.mentionedPaths.length > 0) {
    lines.push(`Paths: ${ctx.mentionedPaths.slice(0, 10).join(", ")}`)
  }
  if (ctx.mentionedBeads.length > 0) {
    lines.push(`Beads: ${ctx.mentionedBeads.slice(0, 10).join(", ")}`)
  }
  if (ctx.mentionedTokens.length > 0) {
    lines.push(`Distinctive tokens: ${ctx.mentionedTokens.slice(0, 20).join(", ")}`)
  }

  // Last 800 chars of the conversation tail as a preview
  const preview = ctx.recentMessages.slice(-800)
  if (preview.length > 0) {
    lines.push("")
    lines.push("Recent conversation tail:")
    lines.push(indent(preview, "  "))
  }

  return lines.join("\n")
}

/**
 * Render a full current-brief result: the session brief when one was found,
 * or a loud diagnostic block explaining why no active session was identified
 * (which roots were searched, what was chosen, freshness, exclusion reasons).
 */
export function renderSessionBriefResult(result: CurrentSessionResolution): string {
  if (result.context) return renderSessionBrief(result.context)

  const reasonLabel: Record<NoSessionReason, string> = {
    "no-candidate": "no cwd-matching session transcript found",
    unreadable: "the chosen transcript could not be read",
    empty: "the chosen transcript had no readable messages",
    stale: "the freshest matching session is older than the freshness window",
  }
  const why = result.reason ? reasonLabel[result.reason] : "unknown"

  const lines: string[] = []
  lines.push(`(no active agent session — ${why})`)
  lines.push("")
  lines.push("Session discovery diagnostics:")
  lines.push(indent(renderDiscoveryDiagnostics(result.diagnostics), "  "))
  return lines.join("\n")
}

/**
 * Render the session context as a section for the planner prompt.
 * Distinct from the brief: more structured, intended for an LLM to read.
 */
export function renderSessionContextForPlanner(ctx: SessionContext): string {
  const parts: string[] = []
  parts.push(
    `CURRENT WORKING SESSION (last activity ${ctx.ageMs === null ? "unknown" : `${Math.round(ctx.ageMs / 60_000)}m ago`}):`,
  )
  parts.push("(The user's query below may or may not relate to this recent work — use only if relevant.)")
  parts.push("")

  if (ctx.mentionedPaths.length > 0) {
    parts.push(`Files touched in this session: ${ctx.mentionedPaths.slice(0, 15).join(", ")}`)
  }
  if (ctx.mentionedBeads.length > 0) {
    parts.push(`Beads mentioned: ${ctx.mentionedBeads.slice(0, 10).join(", ")}`)
  }
  if (ctx.mentionedTokens.length > 0) {
    parts.push(`Distinctive tokens: ${ctx.mentionedTokens.slice(0, 25).join(", ")}`)
  }
  parts.push("")
  parts.push("Recent conversation tail:")
  parts.push(ctx.recentMessages)

  return parts.join("\n")
}

// ============================================================================
// Focus extraction — path-based (used by the bear daemon's focus poller)
// ============================================================================

export interface SessionFocus {
  sessionId: string | null
  transcriptPath: string
  ageMs: number | null
  lastActivityTs: number | null
  exchangeCount: number
  mentionedPaths: string[]
  mentionedBeads: string[]
  mentionedTokens: string[]
  /** Flattened tail of recent exchanges, truncated to maxChars. */
  tail: string
}

/**
 * Extract focus from a JSONL transcript path. Pure — no detection, no env
 * lookups, no sentinel reads. The caller supplies the path. Used by the
 * bear daemon to poll each registered session's current activity.
 *
 * Unlike `getCurrentSessionContext`, this does NOT drop stale sessions —
 * the caller decides staleness policy. Returns null only if the file is
 * unreadable or empty.
 */
export function extractSessionFocus(
  transcriptPath: string,
  opts: { tailLines?: number; maxChars?: number; maxTokens?: number; sessionId?: string } = {},
): SessionFocus | null {
  const { tailLines = 400, maxChars = 6000, maxTokens = 40, sessionId = null } = opts
  let lines: string[]
  try {
    lines = readLastLines(transcriptPath, tailLines)
  } catch {
    // silent-fallback-allow: unreadable transcript tail means no extracted session focus.
    return null
  }
  if (lines.length === 0) return null

  const messages = extractUserAssistantText(lines)
  const lastTimestamp = findLastTimestamp(lines)
  const ageMs = lastTimestamp !== null ? Date.now() - lastTimestamp : null

  const flat = messages.map(formatExchange).join("\n\n")
  const tail = flat.length > maxChars ? flat.slice(-maxChars) : flat

  return {
    sessionId,
    transcriptPath,
    ageMs,
    lastActivityTs: lastTimestamp,
    exchangeCount: messages.length,
    mentionedPaths: extractPaths(tail),
    mentionedBeads: extractBeadIds(tail),
    mentionedTokens: extractTechTokens(tail).slice(0, maxTokens),
    tail,
  }
}

// ============================================================================
// JSONL reading
// ============================================================================

// ============================================================================
// Session sentinel reader
// ============================================================================

interface SessionSentinelRead {
  claudePid: number
  sessionId: string
  transcriptPath?: string
  cwd?: string
  ts: number
}

/**
 * Read the sentinel written by the UserPromptSubmit hook. Walks up the
 * process tree to find the ancestor `claude` process, then reads
 * `<home>/.claude/bearly-sessions/pid-<pid>.json`.
 *
 * Returns null if no ancestor claude PID is found or no sentinel exists
 * for it. Silent on all errors — sentinel is an optimization, not required.
 */
function readSessionSentinel(home: string): SessionSentinelRead | null {
  const sentinelDir = path.join(home, ".claude", "bearly-sessions")
  // First try: any ancestor PID has a sentinel. Walk up cheaply.
  const ancestors = walkProcessAncestors(6)
  for (const pid of ancestors) {
    const file = path.join(sentinelDir, `pid-${pid}.json`)
    try {
      if (!fs.existsSync(file)) continue
      const raw = fs.readFileSync(file, "utf8")
      const parsed = JSON.parse(raw) as SessionSentinelRead
      if (!parsed.sessionId) continue
      // Stale sentinel check: hook may not have run recently if the session
      // is idle. 2h is generous for "still the active session".
      if (Date.now() - parsed.ts > 2 * 60 * 60 * 1000) continue
      return parsed
    } catch {
      /* try next ancestor */
    }
  }
  return null
}

/**
 * Walk up the process tree, returning ancestor PIDs up to `maxDepth`.
 * Uses `ps` because macOS doesn't expose /proc. Returns empty on failure.
 */
function walkProcessAncestors(maxDepth: number): number[] {
  const pids: number[] = []
  let pid = process.ppid
  for (let i = 0; i < maxDepth; i++) {
    if (!pid || pid === 1) break
    pids.push(pid)
    try {
      const out = execSync(`ps -o ppid= -p ${pid}`, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 500,
      }).trim()
      const next = parseInt(out, 10)
      if (!Number.isFinite(next) || next === pid) break
      pid = next
    } catch {
      break
    }
  }
  return pids
}

function resolveSessionJsonl(sessionId: string, cwd: string, home: string = os.homedir()): string | null {
  const slug = cwd.replaceAll("/", "-")
  const candidate = path.resolve(home, ".claude/projects", slug, `${sessionId}.jsonl`)
  if (fs.existsSync(candidate)) return candidate

  // Also try parent directories — a user may be in a subdir of the session root
  let parent = path.dirname(cwd)
  for (let i = 0; i < 4; i++) {
    const slug2 = parent.replaceAll("/", "-")
    const candidate2 = path.resolve(home, ".claude/projects", slug2, `${sessionId}.jsonl`)
    if (fs.existsSync(candidate2)) return candidate2
    const next = path.dirname(parent)
    if (next === parent) break
    parent = next
  }
  return null
}

/**
 * Read the last N lines of a file efficiently. For JSONL transcripts this
 * avoids loading a 40MB session into memory when we only need the tail.
 */
function readLastLines(filepath: string, n: number): string[] {
  const stat = fs.statSync(filepath)
  const size = stat.size
  if (size === 0) return []

  // Read a tail window — 200 lines ≈ ~40KB for Claude transcripts; be generous
  const windowBytes = Math.min(size, Math.max(64 * 1024, n * 300))
  const start = size - windowBytes

  const fd = fs.openSync(filepath, "r")
  try {
    const buf = Buffer.alloc(windowBytes)
    fs.readSync(fd, buf, 0, windowBytes, start)
    const text = buf.toString("utf8")
    const allLines = text.split("\n").filter(Boolean)
    // Drop the first line if we started mid-line (partial JSON)
    const startedMidLine = start > 0 && text[0] !== "\n"
    const lines = startedMidLine ? allLines.slice(1) : allLines
    return lines.slice(-n)
  } finally {
    fs.closeSync(fd)
  }
}

// ============================================================================
// Message extraction
// ============================================================================

interface Exchange {
  role: "user" | "assistant"
  text: string
  timestamp: number | null
}

function extractUserAssistantText(lines: string[]): Exchange[] {
  const out: Exchange[] = []

  for (const raw of lines) {
    let obj: unknown
    try {
      obj = JSON.parse(raw)
    } catch {
      continue
    }
    if (!obj || typeof obj !== "object") continue

    const rec = obj as {
      type?: string
      timestamp?: string | number
      message?: { role?: string; content?: unknown }
    }

    // Claude Code transcripts have type="user" or type="assistant" (or "human")
    const t = rec.type
    if (t !== "user" && t !== "assistant" && t !== "human") continue

    const role: "user" | "assistant" = t === "assistant" ? "assistant" : "user"
    const content = rec.message?.content
    const text = extractText(content)
    if (!text || text.length < 3) continue

    const ts =
      typeof rec.timestamp === "number"
        ? rec.timestamp
        : typeof rec.timestamp === "string"
          ? Date.parse(rec.timestamp) || null
          : null

    out.push({ role, text, timestamp: ts })
  }

  return out
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""

  const parts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== "object") continue
    const b = block as { type?: string; text?: unknown; content?: unknown }
    if (b.type === "text" && typeof b.text === "string") {
      parts.push(b.text)
    } else if (b.type === "tool_use" && typeof b.content === "string") {
      // Skip tool invocations — they inflate tokens and rarely have query intent
    }
  }
  return parts.join("\n")
}

/** Dispatch message extraction by transcript format. */
function extractMessages(lines: string[], format: SessionFormat): Exchange[] {
  return format === "codex" ? extractCodexText(lines) : extractUserAssistantText(lines)
}

/**
 * Extract user/assistant text from a Codex rollout transcript. Each line is
 * `{ timestamp, type: "response_item", payload: { type: "message", role,
 * content: [{ type: "input_text" | "output_text", text }] } }`. `developer`
 * and `reasoning` records are skipped — only user/assistant turns carry intent.
 */
function extractCodexText(lines: string[]): Exchange[] {
  const out: Exchange[] = []

  for (const raw of lines) {
    let obj: unknown
    try {
      obj = JSON.parse(raw)
    } catch {
      continue
    }
    if (!obj || typeof obj !== "object") continue

    const rec = obj as {
      type?: string
      timestamp?: string | number
      payload?: { type?: string; role?: string; content?: unknown }
    }
    if (rec.type !== "response_item") continue
    const p = rec.payload
    if (!p || p.type !== "message") continue
    if (p.role !== "user" && p.role !== "assistant") continue

    const text = extractCodexContent(p.content)
    if (!text || text.length < 3) continue

    out.push({ role: p.role, text, timestamp: parseTimestamp(rec.timestamp) })
  }

  return out
}

function extractCodexContent(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""

  const parts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== "object") continue
    const b = block as { type?: string; text?: unknown }
    if ((b.type === "input_text" || b.type === "output_text") && typeof b.text === "string") {
      parts.push(b.text)
    }
  }
  return parts.join("\n")
}

function parseTimestamp(ts: string | number | undefined): number | null {
  if (typeof ts === "number") return ts
  if (typeof ts === "string") return Date.parse(ts) || null
  return null
}

function formatExchange(e: Exchange): string {
  const label = e.role === "user" ? "USER" : "ASSISTANT"
  // Trim each message to a reasonable length to keep the tail diverse.
  // Prefer more exchanges of medium length over fewer of full length.
  const trimmed = e.text.length > 1200 ? e.text.slice(0, 1100) + " …" : e.text
  return `[${label}] ${trimmed}`
}

function findLastTimestamp(lines: string[]): number | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    try {
      const obj = JSON.parse(line) as { timestamp?: string | number }
      const ts =
        typeof obj.timestamp === "number"
          ? obj.timestamp
          : typeof obj.timestamp === "string"
            ? Date.parse(obj.timestamp) || null
            : null
      if (ts !== null) return ts
    } catch {
      /* skip */
    }
  }
  return null
}

// ============================================================================
// Entity extraction (regex-based, cheap)
// ============================================================================

// File paths: /abs/path.ext or relative like src/foo/bar.ts or vendor/silvery/x.tsx
const PATH_RE = /(?:\/[\w.-]+)+\.[a-zA-Z0-9]{1,8}|(?<![\w./])[\w.-]+\/[\w./-]+\.[a-zA-Z0-9]{1,8}/g
// Bead IDs: km-<scope> or km-<scope>.<suffix>
const BEAD_RE = /\bkm-[a-z0-9]+(?:\.[a-zA-Z0-9_-]+)?\b/g
// Technical-looking tokens: camelCase, snake_case, kebab-case (>=2 chars between separators)
const TECH_TOKEN_RE = /[A-Za-z][a-zA-Z0-9]*(?:[_-][a-zA-Z0-9]+)+|[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*/g

function extractPaths(text: string): string[] {
  return uniqueCapped(text.match(PATH_RE) ?? [], 20)
}

function extractBeadIds(text: string): string[] {
  return uniqueCapped(text.match(BEAD_RE) ?? [], 15)
}

function extractTechTokens(text: string): string[] {
  const matches = text.match(TECH_TOKEN_RE) ?? []
  // Dedupe case-insensitive but preserve first spelling
  const seen = new Map<string, string>()
  for (const m of matches) {
    if (m.length < 4) continue
    const key = m.toLowerCase()
    if (!seen.has(key)) seen.set(key, m)
  }
  // Sort by rarity proxy: longer + has both case classes first
  return [...seen.values()].sort(techTokenPriority).slice(0, 80)
}

function techTokenPriority(a: string, b: string): number {
  // Prefer tokens with separators (kebab/snake) + mixed case over plain ones
  const score = (t: string) => (/[._-]/.test(t) ? 2 : 0) + (/[A-Z]/.test(t) && /[a-z]/.test(t) ? 1 : 0) + t.length / 20
  return score(b) - score(a)
}

function uniqueCapped(arr: string[], cap: number): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const x of arr) {
    if (seen.has(x)) continue
    seen.add(x)
    out.push(x)
    if (out.length >= cap) break
  }
  return out
}

// ============================================================================
// Small helpers
// ============================================================================

function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((l) => prefix + l)
    .join("\n")
}
