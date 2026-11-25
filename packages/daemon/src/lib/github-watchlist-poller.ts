/**
 * GitHub watchlist poller for Tribe's existing GitHub plugin (#38449, @cto 99ecd337).
 *
 * Polls watched issues/PRs (and merges watched repos into the repo event set) using
 * ETag / If-Modified-Since caching, honours X-Poll-Interval, enforces 14-day closed/merged
 * expiry, routes each new comment/review/state-change/merge to the owning seat (plus
 * `@chief/chat` when `operatorFollows`), and raises a loud incident through `pollHealth`
 * on poll failures, 403/429 rate limits, or remaining quota under 500.
 */
import {
  GITHUB_WATCHLIST_EXPIRY_MS,
  readGitHubWatchlist,
  removeGitHubWatchEntriesByKey,
  watchEntryKey,
  type GitHubWatchEntry,
} from "tribe-wire/lib/github-watchlist"
import type { PollError, PollHealth, RateLimitInfo } from "./github-plugin.ts"
import { rateLimitInfoOf } from "./github-plugin.ts"
import type { GitHubWatchlistCursorStore, WatchedItemCursor } from "./github-watchlist-cursor-store.ts"
import type { TribeClientApi } from "./plugin-api.ts"

export const GITHUB_WATCHLIST_INCIDENT_EMITTER = "github"
export const GITHUB_WATCHLIST_INCIDENT_SUBJECT = "watchlist"
export const GITHUB_WATCHLIST_INCIDENT_CONDITION = "poll-failed"
export const GITHUB_WATCHLIST_OPERATOR_SEAT = "@chief/chat"
export const GITHUB_RATE_LIMIT_LOW_THRESHOLD = 500

export interface GitHubIssuePayload {
  readonly number: number
  readonly title: string
  readonly state: string
  readonly html_url: string
  readonly closed_at: string | null
  readonly pull_request?: {
    readonly url?: string
    readonly html_url?: string
    readonly merged_at?: string | null
  }
}

export interface GitHubCommentPayload {
  readonly id: number
  readonly body?: string | null
  readonly html_url: string
  readonly user?: { readonly login?: string } | null
}

export interface GitHubReviewPayload {
  readonly id: number
  readonly state: string
  readonly body?: string | null
  readonly html_url: string
  readonly user?: { readonly login?: string } | null
}

export interface WatchlistFetchResult<T> {
  readonly data: T
  readonly rateLimitRemaining?: number
  readonly rateLimitTotal?: number
  readonly pollIntervalSec?: number
}

export type WatchlistRouterApi = Pick<TribeClientApi, "send"> & {
  readonly listOpenIncidents: NonNullable<TribeClientApi["listOpenIncidents"]>
}

export interface WatchlistPollerOptions {
  readonly watchlistPath: string
  readonly cursorStore: GitHubWatchlistCursorStore
  readonly api: WatchlistRouterApi
  readonly pollHealth: PollHealth
  readonly fetchJson: <T>(path: string) => Promise<WatchlistFetchResult<T>>
  readonly incidentOwner?: string
  readonly now?: () => number
  readonly expiryMs?: number
  readonly rateLimitLowThreshold?: number
  readonly log?: {
    info?(msg: string): void
    warn?(msg: string): void
    debug?(msg: string): void
  }
}

export interface WatchlistPoller {
  pollOnce(): Promise<{
    readonly skipped: boolean
    readonly polledItems: number
    readonly notificationsSent: number
    readonly expiredTargets: readonly string[]
    readonly errors: readonly PollError[]
  }>
  readWatchedRepoEntries(): readonly GitHubWatchEntry[]
}

function firstLine(value: string | null | undefined): string {
  if (typeof value !== "string") return ""
  return (value.split("\n")[0] ?? "").trim().slice(0, 120)
}

function maxId(items: readonly { readonly id: number }[]): number {
  let max = 0
  for (const item of items) {
    if (item.id > max) max = item.id
  }
  return max
}

export function createWatchlistPoller(options: WatchlistPollerOptions): WatchlistPoller {
  const now = options.now ?? Date.now
  const expiryMs = options.expiryMs ?? GITHUB_WATCHLIST_EXPIRY_MS
  const rateLimitLowThreshold = options.rateLimitLowThreshold ?? GITHUB_RATE_LIMIT_LOW_THRESHOLD
  const incidentOwner = options.incidentOwner?.trim() || "@chief"
  let nextAllowedPollAtMs = 0
  let lastIncidentSummary = ""

  function sendWatchRow(entry: GitHubWatchEntry, content: string, topic: string, summary: string): number {
    let sent = 0
    options.api.send(entry.owner, content, "github:watch", undefined, {
      delivery: "push",
      topic,
      summary,
    })
    sent++
    if (entry.operatorFollows && entry.owner !== GITHUB_WATCHLIST_OPERATOR_SEAT) {
      options.api.send(GITHUB_WATCHLIST_OPERATOR_SEAT, content, "github:watch", undefined, {
        delivery: "push",
        topic,
        summary,
      })
      sent++
    }
    return sent
  }

  function isIncidentOpen(): boolean {
    return options.api
      .listOpenIncidents(GITHUB_WATCHLIST_INCIDENT_EMITTER, GITHUB_WATCHLIST_INCIDENT_CONDITION)
      .some((inc) => inc.subject === GITHUB_WATCHLIST_INCIDENT_SUBJECT)
  }

  function raiseIncident(summary: string, detail: string): void {
    if (isIncidentOpen() && summary === lastIncidentSummary) return
    lastIncidentSummary = summary
    options.api.send(
      incidentOwner,
      detail,
      "github:watch",
      undefined,
      {
        delivery: "push",
        topic: "github:watch:poll-failed",
        summary,
      },
      {
        emitter: GITHUB_WATCHLIST_INCIDENT_EMITTER,
        subject: GITHUB_WATCHLIST_INCIDENT_SUBJECT,
        condition: GITHUB_WATCHLIST_INCIDENT_CONDITION,
        active: true,
      },
    )
  }

  function clearIncidentIfOpen(detail: string): void {
    if (!isIncidentOpen()) {
      lastIncidentSummary = ""
      return
    }
    lastIncidentSummary = ""
    options.api.send(
      incidentOwner,
      detail,
      "github:watch",
      undefined,
      {
        delivery: "push",
        topic: "github:watch:recovered",
        summary: "github watchlist polling recovered",
      },
      {
        emitter: GITHUB_WATCHLIST_INCIDENT_EMITTER,
        subject: GITHUB_WATCHLIST_INCIDENT_SUBJECT,
        condition: GITHUB_WATCHLIST_INCIDENT_CONDITION,
        active: false,
      },
    )
  }

  return {
    readWatchedRepoEntries(): readonly GitHubWatchEntry[] {
      const state = readGitHubWatchlist(options.watchlistPath)
      return state.entries.filter((entry) => entry.kind === "repo")
    },

    async pollOnce() {
      const nowMs = now()
      if (nowMs < nextAllowedPollAtMs) {
        return { skipped: true, polledItems: 0, notificationsSent: 0, expiredTargets: [], errors: [] }
      }
      const gate = options.pollHealth.checkGate()
      if (gate.info) options.log?.info?.(gate.info)
      if (gate.skip) {
        return { skipped: true, polledItems: 0, notificationsSent: 0, expiredTargets: [], errors: [] }
      }

      let entries: readonly GitHubWatchEntry[]
      try {
        entries = readGitHubWatchlist(options.watchlistPath).entries
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        options.log?.warn?.(`github watchlist: failed to read ${options.watchlistPath}: ${message}`)
        raiseIncident(
          "github watchlist file unreadable",
          `github watchlist read failed for ${options.watchlistPath}: ${message}`,
        )
        return {
          skipped: false,
          polledItems: 0,
          notificationsSent: 0,
          expiredTargets: [],
          errors: [{ repo: options.watchlistPath, message }],
        }
      }

      const items = entries.filter((entry) => entry.kind === "item" && entry.number !== undefined)
      if (items.length === 0) {
        clearIncidentIfOpen("github watchlist: no watched items; clearing prior poll-failed incident")
        return { skipped: false, polledItems: 0, notificationsSent: 0, expiredTargets: [], errors: [] }
      }

      const errors: PollError[] = []
      let rateLimit: RateLimitInfo | null = null
      let minRemaining: number | undefined
      let observedTotal: number | undefined
      let maxPollIntervalSec = 0
      let notificationsSent = 0
      const expiredKeys = new Set<string>()
      const expiredTargets: string[] = []
      let cursorDirty = false
      const nextCursors: Record<string, WatchedItemCursor> = { ...options.cursorStore.state.items }

      const observeMeta = (res: WatchlistFetchResult<unknown>): void => {
        if (res.rateLimitRemaining !== undefined) {
          minRemaining =
            minRemaining === undefined ? res.rateLimitRemaining : Math.min(minRemaining, res.rateLimitRemaining)
        }
        if (res.rateLimitTotal !== undefined) {
          observedTotal = res.rateLimitTotal
        }
        if (res.pollIntervalSec !== undefined && res.pollIntervalSec > maxPollIntervalSec) {
          maxPollIntervalSec = res.pollIntervalSec
        }
      }

      let polledItems = 0
      for (const entry of items) {
        const number = entry.number
        if (number === undefined) continue
        const key = watchEntryKey(entry)
        try {
          const issueRes = await options.fetchJson<GitHubIssuePayload>(`/repos/${entry.repo}/issues/${number}`)
          observeMeta(issueRes)
          polledItems++

          const issue = issueRes.data
          const mergedAt = issue.pull_request?.merged_at ?? null
          const closedAt = mergedAt ?? issue.closed_at ?? null
          const merged = mergedAt !== null

          // Expiry (@cto 99ecd337): closed or merged > 14 days ago -> remove, log once, tell owner once.
          if (issue.state === "closed" && closedAt !== null) {
            const closedMs = Date.parse(closedAt)
            if (Number.isFinite(closedMs) && nowMs - closedMs > expiryMs) {
              const dateOnly = closedAt.slice(0, 10)
              const line = `stopped watching ${entry.target}: closed ${dateOnly}`
              options.log?.info?.(`github watchlist: ${line}`)
              notificationsSent += sendWatchRow(entry, line, "github:watch:expired", line)
              expiredKeys.add(key)
              expiredTargets.push(entry.target)
              if (nextCursors[key] !== undefined) {
                delete nextCursors[key]
                cursorDirty = true
              }
              continue
            }
          }

          const commentsRes = await options.fetchJson<GitHubCommentPayload[]>(
            `/repos/${entry.repo}/issues/${number}/comments?per_page=100`,
          )
          observeMeta(commentsRes)
          const comments = commentsRes.data

          let reviews: GitHubReviewPayload[] = []
          let reviewComments: GitHubCommentPayload[] = []
          if (issue.pull_request !== undefined) {
            const reviewsRes = await options.fetchJson<GitHubReviewPayload[]>(
              `/repos/${entry.repo}/pulls/${number}/reviews?per_page=100`,
            )
            observeMeta(reviewsRes)
            reviews = reviewsRes.data

            const reviewCommentsRes = await options.fetchJson<GitHubCommentPayload[]>(
              `/repos/${entry.repo}/pulls/${number}/comments?per_page=100`,
            )
            observeMeta(reviewCommentsRes)
            reviewComments = reviewCommentsRes.data
          }

          const latestCommentId = maxId(comments)
          const latestReviewId = maxId(reviews)
          const latestReviewCommentId = maxId(reviewComments)
          const prev = nextCursors[key]
          const nowIso = new Date(nowMs).toISOString()

          if (prev === undefined) {
            // First poll: seed baseline without flooding history.
            nextCursors[key] = {
              state: issue.state,
              merged,
              closedAt,
              lastCommentId: latestCommentId,
              lastReviewId: latestReviewId,
              lastReviewCommentId: latestReviewCommentId,
              lastPollAt: nowIso,
            }
            cursorDirty = true
            continue
          }

          // State change / merge transition
          if (!prev.merged && merged) {
            const summary = `${entry.target} merged`
            const content = `[watch] ${entry.target} merged: ${issue.title} ${issue.html_url}`
            notificationsSent += sendWatchRow(entry, content, "github:watch:merge", summary)
          } else if (prev.state !== issue.state) {
            const transition = issue.state === "open" ? "reopened" : issue.state
            const summary = `${entry.target} ${transition}`
            const content = `[watch] ${entry.target} ${transition}: ${issue.title} ${issue.html_url}`
            notificationsSent += sendWatchRow(entry, content, "github:watch:state", summary)
          }

          // New issue comments (oldest new first)
          const freshComments = comments.filter((c) => c.id > prev.lastCommentId).sort((a, b) => a.id - b.id)
          for (const comment of freshComments) {
            const actor = comment.user?.login ?? "unknown"
            const preview = firstLine(comment.body)
            const tail = preview ? `: ${preview}` : ""
            const summary = `${entry.target} comment by ${actor}`
            const content = `[watch] ${entry.target} comment by ${actor}${tail} ${comment.html_url}`
            notificationsSent += sendWatchRow(entry, content, "github:watch:comment", summary)
          }

          // New PR reviews
          const freshReviews = reviews.filter((r) => r.id > prev.lastReviewId).sort((a, b) => a.id - b.id)
          for (const review of freshReviews) {
            const actor = review.user?.login ?? "unknown"
            const state = review.state.toLowerCase()
            const preview = firstLine(review.body)
            const tail = preview ? `: ${preview}` : ""
            const summary = `${entry.target} review (${state}) by ${actor}`
            const content = `[watch] ${entry.target} review (${state}) by ${actor}${tail} ${review.html_url}`
            notificationsSent += sendWatchRow(entry, content, "github:watch:review", summary)
          }

          // New PR inline review comments
          const freshReviewComments = reviewComments
            .filter((c) => c.id > prev.lastReviewCommentId)
            .sort((a, b) => a.id - b.id)
          for (const comment of freshReviewComments) {
            const actor = comment.user?.login ?? "unknown"
            const preview = firstLine(comment.body)
            const tail = preview ? `: ${preview}` : ""
            const summary = `${entry.target} review comment by ${actor}`
            const content = `[watch] ${entry.target} review comment by ${actor}${tail} ${comment.html_url}`
            notificationsSent += sendWatchRow(entry, content, "github:watch:review-comment", summary)
          }

          const updatedCursor: WatchedItemCursor = {
            state: issue.state,
            merged,
            closedAt,
            lastCommentId: Math.max(prev.lastCommentId, latestCommentId),
            lastReviewId: Math.max(prev.lastReviewId, latestReviewId),
            lastReviewCommentId: Math.max(prev.lastReviewCommentId, latestReviewCommentId),
            lastPollAt: nowIso,
          }
          if (
            updatedCursor.state !== prev.state ||
            updatedCursor.merged !== prev.merged ||
            updatedCursor.closedAt !== prev.closedAt ||
            updatedCursor.lastCommentId !== prev.lastCommentId ||
            updatedCursor.lastReviewId !== prev.lastReviewId ||
            updatedCursor.lastReviewCommentId !== prev.lastReviewCommentId
          ) {
            nextCursors[key] = updatedCursor
            cursorDirty = true
          }
        } catch (err) {
          // delete-fallback-allow: a failed item fetch never adds to expiredKeys, so errors can only shrink the expired set.
          const message = err instanceof Error ? err.message : String(err)
          errors.push({ repo: entry.target, message })
          options.log?.debug?.(`error polling watched item ${entry.target}: ${message}`)
          rateLimit = rateLimitInfoOf(err)
          if (rateLimit) break
        }
      }

      if (expiredKeys.size > 0) {
        removeGitHubWatchEntriesByKey(options.watchlistPath, expiredKeys)
      }
      if (cursorDirty) {
        // Mutate the live state map and persist atomically.
        for (const existingKey of Object.keys(options.cursorStore.state.items)) {
          if (nextCursors[existingKey] === undefined) {
            delete options.cursorStore.state.items[existingKey]
          }
        }
        Object.assign(options.cursorStore.state.items, nextCursors)
        options.cursorStore.save({ items: nextCursors })
      }

      if (maxPollIntervalSec > 0) {
        nextAllowedPollAtMs = nowMs + maxPollIntervalSec * 1000
      }

      const report = options.pollHealth.report("watchlist", {
        errors,
        repoCount: items.length,
        rateLimit,
        rateLimitRemaining: minRemaining,
        rateLimitTotal: observedTotal,
      })
      if (report.warn) options.log?.warn?.(report.warn)
      if (report.info) options.log?.info?.(report.info)

      const lowQuota = minRemaining !== undefined && minRemaining < rateLimitLowThreshold
      if (report.warn !== null) {
        const summary = rateLimit
          ? `github watchlist ${rateLimit.kind} rate limit hit`
          : `github watchlist poll failed (${errors.length}/${items.length})`
        raiseIncident(summary, report.warn)
      } else if (lowQuota) {
        const totalLabel = observedTotal !== undefined ? `/${observedTotal}` : ""
        const warnLine =
          `github watchlist: X-RateLimit-Remaining low (${minRemaining}${totalLabel}, threshold ${rateLimitLowThreshold}) — ` +
          `raising incident before hitting 0`
        options.log?.warn?.(warnLine)
        raiseIncident(`github rate limit low (${minRemaining}${totalLabel} remaining)`, warnLine)
      } else if (errors.length === 0) {
        clearIncidentIfOpen(report.info ?? "github watchlist: recovered — all watched items polling clean")
      }

      return {
        skipped: false,
        polledItems,
        notificationsSent,
        expiredTargets,
        errors,
      }
    },
  }
}
