/**
 * Tribe plugin: GitHub — polls GitHub API for events and broadcasts to all sessions.
 *
 * Extracts the core polling/formatting logic from github-channel.ts (the standalone
 * MCP server) and wraps it as a TribePlugin. One daemon process becomes the GitHub
 * provider; all connected sessions receive notifications via the tribe message bus.
 *
 * Config via env vars (same as github-channel.ts):
 *   GITHUB_TOKEN / `gh auth token`  — authentication
 *   GITHUB_POLL_INTERVAL            — seconds between polls (default: 30)
 *   GITHUB_EVENTS                   — comma-separated event types (default: push,workflow_run,pull_request,issues)
 *   GITHUB_WORKFLOW_NOTIFY          — "all" | "failure" | "success" (default: "failure")
 */

import { execSync } from "node:child_process"
import { dirname, resolve } from "node:path"
import { URLSearchParams } from "node:url"
import { createLogger } from "loggily"
import { findBeadsDir } from "tribe-wire/lib/config"
import { openGitHubCursorStore, resolveGitHubCursorPath } from "./github-cursor-store.ts"
import { createTimers } from "./timers.ts"
import type { TribePluginApi, TribeClientApi } from "./plugin-api.ts"

const log = createLogger("tribe:github")

// ---------------------------------------------------------------------------
// GitHub auth
// ---------------------------------------------------------------------------

export function getGitHubToken(): string | null {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN
  try {
    return execSync("gh auth token", { encoding: "utf-8", stdio: "pipe" }).trim()
  } catch {
    // silent-fallback-allow: absent gh auth token disables the optional GitHub plugin.
    return null
  }
}

/**
 * Human-readable label for WHERE the GitHub monitor token is sourced from, so a
 * credential-rejection warning can name the exact thing to refresh. Mirrors
 * getGitHubToken's precedence (env first, gh CLI second) but is a pure env check
 * — no subprocess — so it is safe to call on the per-failure log path. The label
 * is the config source, NOT the token value (never log the token).
 */
export function gitHubTokenSourceLabel(): string {
  return process.env.GITHUB_TOKEN ? "GITHUB_TOKEN env var" : "`gh auth token` (gh CLI login)"
}

// ---------------------------------------------------------------------------
// Repo detection
// ---------------------------------------------------------------------------

export function detectRepoFromGit(dir?: string): string | null {
  try {
    const url = execSync("git remote get-url origin", {
      cwd: dir ?? process.cwd(),
      encoding: "utf-8",
      stdio: "pipe",
    }).trim()
    const match = url.match(/github\.com[:/](.+?)(?:\.git)?$/)
    return match?.[1] ?? null
  } catch {
    // silent-fallback-allow: non-git cwd or missing origin means no GitHub repo context.
    return null
  }
}

/** Detect GitHub repo from cwd's git remote (for fast startup before API call) */
function detectLocalRepo(): string | null {
  return detectRepoFromGit()
}

/** Fetch all non-archived, non-fork repos owned by the authenticated user */
async function fetchUserRepos(headers: Record<string, string>): Promise<string[]> {
  const repos: string[] = []
  let page = 1
  while (true) {
    const batch = await ghFetch<Array<{ full_name: string; archived: boolean; fork: boolean }>>(
      `/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner`,
      headers,
    )
    if (batch.length === 0) break
    for (const r of batch) {
      if (!r.archived && !r.fork) repos.push(r.full_name)
    }
    if (batch.length < 100) break
    page++
  }
  return repos
}

// ---------------------------------------------------------------------------
// GitHub API
// ---------------------------------------------------------------------------

interface GitHubEvent {
  id: string
  type: string
  actor: { login: string }
  repo: { name: string }
  payload: Record<string, unknown>
  created_at: string
}

interface WorkflowRun {
  id: number
  name: string
  status: string
  conclusion: string | null
  html_url: string
  head_branch: string
  head_sha: string
  run_number: number
  created_at: string
  updated_at: string
  actor: { login: string }
}

// ETag cache — 304 responses don't count against GitHub rate limit
const etagCache = new Map<string, { etag: string; data: unknown }>()
const ETAG_CACHE_MAX = 200

let apiCallsMade = 0
let apiCallsSaved = 0
let rateLimitRemaining = 5000
let rateLimitTotal = 5000

/**
 * Rate-limit metadata attached to a ghFetch error so the POLL LOOP (not the
 * per-request warn) owns the response: pause polling until the budget resets
 * instead of hammering every repo every tick (km ci-github-rate-limits).
 *
 * `primary` = the hourly REST budget (403 + "rate limit" body, or
 * x-ratelimit-remaining: 0). `secondary` = abuse/burst detection (429, or a
 * retry-after header). resetAtMs is null when GitHub sent no usable header —
 * callers apply their own default pause.
 */
export interface RateLimitInfo {
  kind: "primary" | "secondary"
  resetAtMs: number | null
}

/** Extract the RateLimitInfo a ghFetch error carries, if any. */
export function rateLimitInfoOf(err: unknown): RateLimitInfo | null {
  const info = (err as { rateLimit?: RateLimitInfo } | null)?.rateLimit
  return info ?? null
}

export function detectRateLimit(res: Response, body: string): RateLimitInfo | null {
  const retryAfterSec = parseInt(res.headers.get("retry-after") ?? "", 10)
  if (res.status === 429 || Number.isFinite(retryAfterSec)) {
    return {
      kind: "secondary",
      resetAtMs: Number.isFinite(retryAfterSec) ? Date.now() + retryAfterSec * 1000 : null,
    }
  }
  const remaining = parseInt(res.headers.get("x-ratelimit-remaining") ?? "", 10)
  if (res.status === 403 && (/rate limit/i.test(body) || remaining === 0)) {
    const resetSec = parseInt(res.headers.get("x-ratelimit-reset") ?? "", 10)
    return { kind: "primary", resetAtMs: Number.isFinite(resetSec) ? resetSec * 1000 : null }
  }
  return null
}

export async function ghFetch<T>(path: string, headers: Record<string, string>): Promise<T> {
  const url = path.startsWith("https://") ? path : `https://api.github.com${path}`
  const reqHeaders: Record<string, string> = { ...headers }
  const cached = etagCache.get(url)
  if (cached?.etag) reqHeaders["If-None-Match"] = cached.etag

  const res = await fetch(url, { headers: reqHeaders })

  // Track rate limit
  const remaining = res.headers.get("x-ratelimit-remaining")
  const limit = res.headers.get("x-ratelimit-limit")
  if (remaining) rateLimitRemaining = parseInt(remaining, 10)
  if (limit) rateLimitTotal = parseInt(limit, 10)

  if (res.status === 304 && cached) {
    apiCallsSaved++
    return cached.data as T
  }

  apiCallsMade++

  if (!res.ok) {
    const body = await res.text()
    const err = new Error(`GitHub API ${res.status}: ${body.slice(0, 200)}`)
    const rateLimit = detectRateLimit(res, body)
    if (rateLimit) Object.assign(err, { rateLimit })
    throw err
  }

  const data = (await res.json()) as T
  const etag = res.headers.get("etag")
  if (etag) {
    etagCache.set(url, { etag, data })
    if (etagCache.size > ETAG_CACHE_MAX) {
      const oldest = etagCache.keys().next().value
      if (oldest !== undefined) etagCache.delete(oldest)
    }
  }
  return data
}

async function fetchRepoEvents(repo: string, headers: Record<string, string>): Promise<GitHubEvent[]> {
  return ghFetch<GitHubEvent[]>(`/repos/${repo}/events?per_page=30`, headers)
}

export interface PollError {
  repo: string
  message: string
}

/**
 * Summarize a batch of per-repo poll failures for the warn line.
 *
 * The old summary hardcoded "(network issue)" — asserting a cause the code
 * never determined, while the real per-repo errors went to log.debug (which
 * the daemon discards). A rate-limit burst and a DNS blip were
 * indistinguishable from the tribe side (km 19779).
 *
 * Buckets: "rate-limited" (GitHub rate-limit body), "auth-401"/"auth-403"
 * (credential/permission rejection — the read-only GitHub MONITOR rail's token
 * is bad or lacks scope; this is NOT a git-SSH or integrator failure; km 20593),
 * "HTTP <status>" (any other API error response), "network/fetch" (no response
 * at all). Reports bucket counts plus one sample message and the last-seen
 * rate-limit budget so the cause is auditable from the broadcast alone.
 *
 * When an auth bucket is present, appends an actionable credential-owner note:
 * names the token source (so the owner knows WHICH credential to refresh) and
 * states that only the monitor rail is affected — git SSH and the integrator are
 * UNAFFECTED. This keeps a daemon-side monitor-credential problem from being
 * mis-read by @ci/sitrep as a CI/integration failure (km 20593). tokenSource
 * defaults to gitHubTokenSourceLabel(); pass it explicitly in tests.
 */
export function summarizePollErrors(
  errors: PollError[],
  remaining: number,
  total: number,
  tokenSource?: string,
): string {
  const classOf = (msg: string): string => {
    if (/rate limit/i.test(msg)) return "rate-limited"
    const status = msg.match(/GitHub API (\d{3})/)?.[1]
    // 401 = bad/expired credentials; non-rate-limit 403 = token lacks scope.
    // Both are credential-rail problems distinct from a transient HTTP/network blip.
    if (status === "401") return "auth-401"
    if (status === "403") return "auth-403"
    if (status) return `HTTP ${status}`
    return "network/fetch"
  }
  const counts = new Map<string, number>()
  for (const e of errors) {
    const cls = classOf(e.message)
    counts.set(cls, (counts.get(cls) ?? 0) + 1)
  }
  const buckets = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([cls, n]) => `${cls}×${n}`)
    .join(", ")
  const sample = errors[0]
  if (sample === undefined) throw new Error("summarizePollErrors requires at least one poll error")
  // Collapse whitespace so a raw multi-line API payload in the error body
  // can never spray log-line-shaped content into the warn (the defang layer
  // otherwise redacts each sprayed line into `[n]` noise in member panes).
  const sampleMsg = sample.message.replace(/\s+/g, " ").slice(0, 120)
  const base = `${buckets}; sample ${sample.repo}: ${sampleMsg}; rate limit ${remaining}/${total}`
  const hasAuth = [...counts.keys()].some((c) => c.startsWith("auth-"))
  if (!hasAuth) return base
  const src = tokenSource ?? gitHubTokenSourceLabel()
  return (
    `${base} — GitHub MONITOR-RAIL credential rejected (token source: ${src}); ` +
    `refresh with \`gh auth login\` or set GITHUB_TOKEN; git SSH + integrator UNAFFECTED`
  )
}

// ---------------------------------------------------------------------------
// Poll health — pause/backoff gate + warn dedup
// ---------------------------------------------------------------------------

/** Escalating pause steps for an all-repos-down outage (network or API). */
const OUTAGE_BACKOFF_STEPS_MS = [2 * 60_000, 5 * 60_000, 15 * 60_000]
/** Re-warn at most this often while the same failure signature persists. */
const WARN_HEARTBEAT_MS = 10 * 60_000
/** Pause when rate-limited but GitHub sent no usable reset header. */
const RATE_LIMIT_DEFAULT_PAUSE_MS = 15 * 60_000
/** Never pause longer than this, even if the reset header says so. */
const PAUSE_CAP_MS = 90 * 60_000
/** Slack past the advertised reset so we don't resume a second early. */
const RATE_LIMIT_RESUME_SLACK_MS = 30_000

export interface PollReport {
  /** Warn line to emit, or null when deduped/quiet. */
  warn: string | null
  /** Info line (pause/resume/recovery notes), or null. */
  info: string | null
}

export interface PollHealth {
  /**
   * Call at the top of a poll tick. `skip: true` means the gate is paused
   * (rate-limit or outage backoff) — do not poll. On the first tick after a
   * pause expires, `info` carries a resume note (emit once).
   */
  checkGate(): { skip: boolean; info: string | null }
  /**
   * Report a completed poll pass for one leg ("events" | "workflows").
   * Owns rate-limit pausing, outage backoff, warn dedup, and recovery notes.
   */
  report(leg: string, result: { errors: PollError[]; repoCount: number; rateLimit: RateLimitInfo | null }): PollReport
}

/**
 * Shared poll-health gate for the GitHub plugin's polling legs.
 *
 * Why this exists (km ci-github-rate-limits + tribe-server-health-rollout,
 * 2026-07-02): during a rate-limit burst or a network outage the old code
 * kept polling every repo every tick and emitted an identical
 * "N/N repos failed" warn each time — 23/23-repo warn floods every 60s,
 * with raw API payload samples, sprayed into the daemon log and (post-defang)
 * into member panes. The fix is state, not louder logging:
 *
 * - RATE LIMIT: polling PAUSES until x-ratelimit-reset (+30s slack, capped),
 *   warned ONCE with the reset time; one resume note on expiry. The pause is
 *   shared across legs — one budget, one clock.
 * - OUTAGE (every repo failed): escalating pause 2m → 5m → 15m, warned once
 *   per escalation; recovery note when a poll succeeds again.
 * - WARN DEDUP: an unchanged failure signature (same leg, same class×count
 *   buckets) re-warns at most every 10 min, with a suppressed-count suffix;
 *   a changed signature warns immediately. Recovery (errors → 0 after a
 *   warned state) emits one info line.
 *
 * Pure state machine over injected `now` — no timers, fully unit-testable.
 * retire-when: the plugin moves from polling to webhook/push topology (the
 * AVOID leg of km ci-github-rate-limits) — delete together with the pollers.
 */
export function createPollHealth(now: () => number = Date.now): PollHealth {
  let pausedUntilMs = 0
  let pauseReason: "rate-limit" | "outage" | null = null
  let outageStep = -1 // index into OUTAGE_BACKOFF_STEPS_MS; -1 = healthy
  const legs = new Map<string, { signature: string; lastWarnAtMs: number; suppressed: number }>()

  const fmtMin = (ms: number): string => `${Math.max(1, Math.round(ms / 60_000))}min`

  function pause(reason: "rate-limit" | "outage", untilMs: number): void {
    pausedUntilMs = Math.min(untilMs, now() + PAUSE_CAP_MS)
    pauseReason = reason
  }

  return {
    checkGate() {
      if (pausedUntilMs > now()) return { skip: true, info: null }
      if (pauseReason !== null) {
        // Pause just expired — resume and say so once.
        const reason = pauseReason
        pauseReason = null
        pausedUntilMs = 0
        return { skip: false, info: `github polling resumed after ${reason} pause` }
      }
      return { skip: false, info: null }
    },

    report(leg, { errors, repoCount, rateLimit }) {
      const state = legs.get(leg) ?? { signature: "", lastWarnAtMs: 0, suppressed: 0 }
      legs.set(leg, state)

      // --- Recovery: clean poll after a warned state ---
      if (errors.length === 0) {
        let info: string | null = null
        if (state.signature !== "") {
          info = `github ${leg}: recovered — all repos polling clean`
          state.signature = ""
          state.lastWarnAtMs = 0
          state.suppressed = 0
        }
        if (outageStep >= 0) outageStep = -1
        return { warn: null, info }
      }

      const summary = summarizePollErrors(errors, rateLimitRemaining, rateLimitTotal)

      // --- Rate limit: pause polling until the budget resets, warn once ---
      if (rateLimit) {
        const alreadyPaused = pauseReason === "rate-limit" && pausedUntilMs > now()
        const untilMs = (rateLimit.resetAtMs ?? now() + RATE_LIMIT_DEFAULT_PAUSE_MS) + RATE_LIMIT_RESUME_SLACK_MS
        // Floor at 5min: a stale/past reset header must not degrade into a
        // warn-per-minute loop — the exact failure shape this gate removes.
        pause("rate-limit", Math.max(untilMs, now() + 5 * 60_000))
        if (alreadyPaused) return { warn: null, info: null }
        return {
          warn:
            `github ${leg}: ${rateLimit.kind} rate limit hit — PAUSING all github polling ` +
            `for ${fmtMin(pausedUntilMs - now())} (until budget reset) — ${summary}`,
          info: null,
        }
      }

      // --- Outage: every repo failed → escalating backoff ---
      if (errors.length >= repoCount && repoCount > 0) {
        outageStep = Math.min(outageStep + 1, OUTAGE_BACKOFF_STEPS_MS.length - 1)
        const stepMs = OUTAGE_BACKOFF_STEPS_MS[outageStep]
        if (stepMs === undefined) throw new Error(`outage backoff step ${outageStep} is not configured`)
        pause("outage", now() + stepMs)
        state.signature = `outage:${errors.length}/${repoCount}`
        state.lastWarnAtMs = now()
        return {
          warn:
            `github ${leg}: ${errors.length}/${repoCount} repos failed (ALL) — backing off ` +
            `${fmtMin(stepMs)} — ${summary}`,
          info: null,
        }
      }
      outageStep = -1

      // --- Partial failure: dedup identical signatures ---
      const signature = `${leg}:${summary.split("; sample")[0]}`
      const changed = signature !== state.signature
      const heartbeatDue = now() - state.lastWarnAtMs >= WARN_HEARTBEAT_MS
      if (!changed && !heartbeatDue) {
        state.suppressed++
        return { warn: null, info: null }
      }
      const suffix = state.suppressed > 0 ? ` (${state.suppressed} identical warns suppressed)` : ""
      state.signature = signature
      state.lastWarnAtMs = now()
      state.suppressed = 0
      return {
        warn: `github ${leg}: ${errors.length}/${repoCount} repos failed — ${summary}${suffix}`,
        info: null,
      }
    },
  }
}

async function fetchWorkflowRuns(
  repo: string,
  headers: Record<string, string>,
  status?: string,
): Promise<WorkflowRun[]> {
  const params = new URLSearchParams({ per_page: "20" })
  if (status) params.set("status", status)
  const data = await ghFetch<{ workflow_runs: WorkflowRun[] }>(
    `/repos/${repo}/actions/runs?${params.toString()}`,
    headers,
  )
  return data.workflow_runs
}

// ---------------------------------------------------------------------------
// Event formatting
// ---------------------------------------------------------------------------

export function formatEvent(
  event: GitHubEvent,
  eventTypes: string[],
): { line: string; type: string; url: string } | null {
  const actor = event.actor.login
  const repo = event.repo.name
  const payload = event.payload

  switch (event.type) {
    case "PushEvent": {
      if (!eventTypes.includes("push")) return null
      const commits = payload.commits as Array<{ sha: string; message: string }> | undefined
      const count = commits?.length ?? (payload.distinct_size as number) ?? (payload.size as number) ?? 0
      const branch = (payload.ref as string)?.replace("refs/heads/", "") ?? "unknown"
      const lastMsg = commits?.[commits.length - 1]?.message?.split("\n")[0] ?? ""
      const url = `https://github.com/${repo}/compare/${(payload.before as string)?.slice(0, 7)}...${(payload.head as string)?.slice(0, 7)}`
      const countStr = count > 0 ? `${count} commit${count !== 1 ? "s" : ""}` : "changes"
      return {
        line: `${repo}: ${actor} pushed ${countStr} to ${branch} — ${lastMsg}`,
        type: "push",
        url,
      }
    }

    case "PullRequestEvent": {
      if (!eventTypes.includes("pull_request")) return null
      const pr = payload.pull_request as { number: number; title: string; html_url: string } | undefined
      const action = payload.action as string
      if (!pr) return null
      return {
        line: `[pr] ${repo}: ${actor} ${action} PR #${pr.number}: ${pr.title}`,
        type: "pr",
        url: pr.html_url,
      }
    }

    case "PullRequestReviewEvent": {
      if (!eventTypes.includes("pull_request")) return null
      const review = payload.review as { state: string; html_url: string } | undefined
      const prNum = (payload.pull_request as { number: number })?.number
      const prTitle = (payload.pull_request as { title: string })?.title
      if (!review) return null
      return {
        line: `[review] ${repo}: ${actor} ${review.state} review on PR #${prNum}: ${prTitle}`,
        type: "pr",
        url: review.html_url,
      }
    }

    case "PullRequestReviewCommentEvent": {
      if (!eventTypes.includes("pull_request")) return null
      const comment = payload.comment as { html_url: string; body: string } | undefined
      const prNumC = (payload.pull_request as { number: number })?.number
      if (!comment) return null
      const body = (comment.body.split("\n")[0] ?? "").slice(0, 80)
      return {
        line: `[pr-comment] ${repo}: ${actor} commented on PR #${prNumC}: ${body}`,
        type: "pr",
        url: comment.html_url,
      }
    }

    case "IssuesEvent": {
      if (!eventTypes.includes("issues")) return null
      const issue = payload.issue as { number: number; title: string; html_url: string } | undefined
      const issueAction = payload.action as string
      if (!issue) return null
      return {
        line: `[issue] ${repo}: ${actor} ${issueAction} #${issue.number}: ${issue.title}`,
        type: "issue",
        url: issue.html_url,
      }
    }

    case "IssueCommentEvent": {
      if (!eventTypes.includes("issues")) return null
      const issueC = payload.issue as { number: number; title: string } | undefined
      const commentC = payload.comment as { html_url: string; body: string } | undefined
      if (!issueC || !commentC) return null
      const bodyC = (commentC.body.split("\n")[0] ?? "").slice(0, 80)
      return {
        line: `[issue-comment] ${repo}: ${actor} on #${issueC.number}: ${bodyC}`,
        type: "issue",
        url: commentC.html_url,
      }
    }

    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

export const githubPlugin: TribePluginApi = {
  name: "github",

  available() {
    const token = getGitHubToken()
    if (!token) {
      log.info?.("no GitHub token available (skipped)")
      return false
    }
    return true
  },

  start(api: TribeClientApi) {
    const token = getGitHubToken()
    if (!token) return

    const githubHeaders = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "bearly-github-plugin/0.1.0",
    }

    const pollIntervalSec = parseInt(process.env.GITHUB_POLL_INTERVAL ?? "60", 10) || 60
    const eventTypes = (process.env.GITHUB_EVENTS ?? "push,workflow_run,pull_request,issues").split(",").filter(Boolean)
    const workflowNotify = (process.env.GITHUB_WORKFLOW_NOTIFY ?? "failure") as "all" | "failure" | "success"

    const cursorPath = resolveGitHubCursorPath()
    const beadsDir = findBeadsDir()
    const cursorStore = openGitHubCursorStore({
      stateDir: dirname(cursorPath),
      legacyPath: beadsDir === null ? null : resolve(beadsDir, "github-cursor.json"),
    })
    const cursorState = cursorStore.state

    // Dedup sets — prevent duplicate delivery across reloads
    const seenEventIds = new Set<string>()
    const seenWorkflowUrls = new Set<string>()

    // CI state tracking per repo — consecutive failures trigger escalation
    const ciState = new Map<string, { consecutiveFailures: number }>()

    // Track recent pushes: repo → { session, timestamp } for CI correlation
    const recentPushers = new Map<string, { actor: string; timestamp: number }>()

    // Start with local repo for fast startup, then discover all user repos via API
    const repos = new Set<string>()
    const local = detectLocalRepo()
    if (local) repos.add(local)
    log.info?.(`local repo: ${local ?? "none"}`)

    // Async: fetch all user repos and merge
    void fetchUserRepos(githubHeaders)
      .then((userRepos) => {
        for (const r of userRepos) repos.add(r)
        const all = Array.from(repos).sort()
        log.info?.(`monitoring ${all.length} repos: ${all.join(", ")}`)
        return undefined
      })
      .catch((err) => {
        log.error?.(`failed to fetch user repos: ${err instanceof Error ? err.message : err}`)
      })

    log.info?.(`event types: ${eventTypes.join(", ")}, workflow notify: ${workflowNotify}`)
    log.info?.(`cursor: ${cursorPath}`)

    // Shared pause/backoff gate + warn dedup for both polling legs
    const pollHealth = createPollHealth()

    // --- Event polling ---

    async function pollEvents(): Promise<void> {
      const gate = pollHealth.checkGate()
      if (gate.info) log.info?.(gate.info)
      if (gate.skip) return
      const errors: PollError[] = []
      let rateLimit: RateLimitInfo | null = null
      for (const r of repos) {
        try {
          const events = await fetchRepoEvents(r, githubHeaders)
          const repoCursor = cursorState.repos[r]
          const lastSeenId = repoCursor?.lastEventId

          // First poll or no cursor: set cursor without delivering
          if (!lastSeenId) {
            const first = events[0]
            if (first !== undefined) {
              cursorState.repos[r] = {
                lastEventId: first.id,
                lastPollAt: new Date().toISOString(),
              }
              cursorStore.save(cursorState)
            }
            continue
          }

          // Collect new events (stop at cursor)
          const newEvents: GitHubEvent[] = []
          for (const event of events) {
            if (event.id === lastSeenId) break
            newEvents.push(event)
          }

          // Cap at 3 events per repo per poll to avoid flooding on cursor miss
          const capped = newEvents.slice(0, 3)
          for (const event of capped.reverse()) {
            if (seenEventIds.has(event.id)) continue
            seenEventIds.add(event.id)
            if (seenEventIds.size > 500) seenEventIds.clear()

            const formatted = formatEvent(event, eventTypes)
            if (!formatted) continue

            // Skip push events for the local repo — git plugin already broadcasts commits
            if (formatted.type === "push" && r === local) continue

            // km-tribe.event-classification: routine repo activity (push, PR
            // open, issue, release) is ambient — informational for the tribe
            // but no agent needs to react. CI alerts (escalated below via
            // consecutive-failure threshold) stay actionable.
            api.broadcast(`${formatted.line} ${formatted.url}`, `github:${formatted.type}`, undefined, {
              delivery: "pull",
              topic: `github:${formatted.type}`,
            })

            // Track who pushed to each repo for CI correlation
            if (formatted.type === "push") {
              recentPushers.set(r, { actor: event.actor.login, timestamp: Date.now() })
            }
          }

          // Update cursor
          const first = events[0]
          if (first !== undefined) {
            cursorState.repos[r] = {
              lastEventId: first.id,
              lastPollAt: new Date().toISOString(),
            }
            cursorStore.save(cursorState)
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          errors.push({ repo: r, message })
          log.debug?.(`error polling ${r}: ${message}`)
          rateLimit = rateLimitInfoOf(err)
          if (rateLimit) break // budget exhausted — stop hammering remaining repos
        }
      }
      const report = pollHealth.report("events", { errors, repoCount: repos.size, rateLimit })
      if (report.warn) log.warn?.(report.warn)
      if (report.info) log.info?.(report.info)
    }

    // --- Workflow run polling ---

    async function pollWorkflows(): Promise<void> {
      const gate = pollHealth.checkGate()
      if (gate.info) log.info?.(gate.info)
      if (gate.skip) return
      const errors: PollError[] = []
      let rateLimit: RateLimitInfo | null = null
      for (const r of repos) {
        if (!eventTypes.includes("workflow_run")) continue
        try {
          const runs = await fetchWorkflowRuns(r, githubHeaders, "completed")

          // Process all completed runs for CI state tracking, but only broadcast per workflowNotify
          const cutoff = Date.now() - 5 * 60 * 1000
          const recent = runs.filter((run) => run.conclusion !== null && new Date(run.updated_at).getTime() > cutoff)

          for (const run of recent.slice(0, 5)) {
            if (seenWorkflowUrls.has(run.html_url)) continue
            seenWorkflowUrls.add(run.html_url)
            if (seenWorkflowUrls.size > 1000) seenWorkflowUrls.clear()

            // Broadcast based on workflowNotify filter
            const shouldNotify = workflowNotify === "all" || run.conclusion === workflowNotify
            if (shouldNotify) {
              const status =
                run.conclusion === "success"
                  ? "PASSED"
                  : run.conclusion === "failure"
                    ? "FAILED"
                    : String(run.conclusion).toUpperCase()
              const emoji = run.conclusion === "success" ? "✓" : run.conclusion === "failure" ? "✗" : "?"
              const line = `[workflow] ${r}: ${emoji} ${run.name} #${run.run_number} ${status} on ${run.head_branch} (${run.actor.login})`
              // km-tribe.event-classification: a single workflow conclusion is
              // ambient — only the escalated `CI ALERT` (3+ consecutive
              // failures) is actionable, fired separately below. The reply
              // hint is derived at delivery time on the channel envelope.
              api.broadcast(`${line} ${run.html_url}`, `github:workflow`, undefined, {
                delivery: "pull",
                topic: `github:workflow:${run.conclusion}`,
              })
            }

            // Track CI state per repo for escalation (always, regardless of notify filter)
            const key = `${r}:${run.name}`
            const state = ciState.get(key) ?? { consecutiveFailures: 0 }
            if (run.conclusion === "failure") {
              state.consecutiveFailures++
              ciState.set(key, state)

              if (state.consecutiveFailures === 3) {
                const pusher = recentPushers.get(r)
                const pusherInfo = pusher ? ` Last push by ${pusher.actor}.` : ""
                api.broadcast(
                  `CI ALERT: ${r} ${run.name} has failed ${state.consecutiveFailures}x consecutively.${pusherInfo} Fix before pushing more.`,
                  "github:ci-alert",
                  undefined,
                  { delivery: "push", topic: "github:ci-alert" },
                )

                // DM sessions that might be responsible — match by repo name in session names
                const repoShort = r.split("/")[1] ?? r
                for (const name of api.getSessionNames()) {
                  if (name.includes(repoShort) || name.includes(repoShort.replace(".dev", ""))) {
                    api.send(
                      name,
                      `Your repo ${r} has CI failures (${run.name} failed ${state.consecutiveFailures}x). Check ${run.html_url}`,
                      "github:ci-alert",
                      undefined,
                      { delivery: "push", topic: "github:ci-alert" },
                    )
                  }
                }
              } else if (state.consecutiveFailures > 3 && state.consecutiveFailures % 5 === 0) {
                api.broadcast(
                  `CI ALERT: ${r} ${run.name} still broken — ${state.consecutiveFailures} consecutive failures`,
                  "github:ci-alert",
                  undefined,
                  { delivery: "push", topic: "github:ci-alert" },
                )
              }
            } else if (run.conclusion === "success") {
              if (state.consecutiveFailures >= 3) {
                api.broadcast(
                  `CI RECOVERED: ${r} ${run.name} green after ${state.consecutiveFailures} failures`,
                  "github:ci-recovered",
                  undefined,
                  { delivery: "push", topic: "github:ci-recovered" },
                )
              }
              state.consecutiveFailures = 0
              ciState.set(key, state)
            }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          errors.push({ repo: r, message })
          log.debug?.(`error polling workflows for ${r}: ${message}`)
          rateLimit = rateLimitInfoOf(err)
          if (rateLimit) break // budget exhausted — stop hammering remaining repos
        }
      }
      const report = pollHealth.report("workflows", { errors, repoCount: repos.size, rateLimit })
      if (report.warn) log.warn?.(report.warn)
      if (report.info) log.info?.(report.info)
    }

    const ac = new AbortController()
    const timers = createTimers(ac.signal)

    // Rate limit status logging
    timers.setInterval(
      () => {
        log.info?.(
          `rate limit: ${rateLimitRemaining}/${rateLimitTotal} remaining. Calls: ${apiCallsMade} made, ${apiCallsSaved} saved by ETag`,
        )
      },
      5 * 60 * 1000,
    )

    // Initial poll
    void pollEvents()

    // Regular polling
    timers.setInterval(() => void pollEvents(), pollIntervalSec * 1000)

    // Workflow polling (every 60s, separate endpoint)
    timers.setInterval(() => void pollWorkflows(), 60_000)
    // Initial workflow poll after short delay
    timers.setTimeout(() => void pollWorkflows(), 5_000)

    // Cleanup
    return () => {
      ac.abort()
      cursorStore.save(cursorState)
    }
  },

  instructions() {
    const repo = detectRepoFromGit()
    return `- GitHub integration active: push, PR, CI, and issue notifications are delivered automatically for ${repo ?? "detected repo"}`
  },
}
