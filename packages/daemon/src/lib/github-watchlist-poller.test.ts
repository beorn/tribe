/**
 * @failure Watched GitHub items flood history on first poll, misroute notifications
 *   (or drop `@chief/chat` when `--operator` is set), never expire after 14 days closed,
 *   ignore X-Poll-Interval, or fail silently on 403 / <500 remaining rate limit (#38449, @cto 99ecd337).
 * @level L2 — watchlist polling state machine, routing, expiry, rate-limit incident lifecycle.
 * @consumer `createWatchlistPoller` in `github-watchlist-poller.ts`.
 * @testonly none
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { addGitHubWatchEntry, readGitHubWatchlist } from "tribe-wire/lib/github-watchlist"
import { createPollHealth, type RateLimitInfo } from "./github-plugin.ts"
import { openGitHubWatchlistCursorStore } from "./github-watchlist-cursor-store.ts"
import {
  createWatchlistPoller,
  GITHUB_WATCHLIST_INCIDENT_CONDITION,
  GITHUB_WATCHLIST_INCIDENT_EMITTER,
  GITHUB_WATCHLIST_INCIDENT_SUBJECT,
  GITHUB_WATCHLIST_OPERATOR_SEAT,
  type GitHubCommentPayload,
  type GitHubIssuePayload,
  type GitHubReviewPayload,
  type WatchlistFetchResult,
  type WatchlistRouterApi,
} from "./github-watchlist-poller.ts"
import type { EventClassification } from "./plugin-api.ts"
import type { IncidentIdentity } from "tribe-wire"

const tempDirs: string[] = []
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

interface RecordedSend {
  readonly recipient: string
  readonly content: string
  readonly type: string
  readonly classification?: EventClassification
  readonly incident?: IncidentIdentity & { active?: boolean }
}

function makeFakeApi(): {
  readonly api: WatchlistRouterApi
  readonly sent: RecordedSend[]
  readonly openIncidents: Map<string, { subject: string; recipient: string }>
} {
  const sent: RecordedSend[] = []
  const openIncidents = new Map<string, { subject: string; recipient: string }>()
  const api: WatchlistRouterApi = {
    send(recipient, content, type, _beadId, classification, incident) {
      sent.push({ recipient, content, type, classification, incident })
      if (incident) {
        const key = `${incident.emitter}:${incident.subject}:${incident.condition}`
        if (incident.active === false) {
          openIncidents.delete(key)
        } else {
          openIncidents.set(key, { subject: incident.subject, recipient })
        }
      }
    },
    listOpenIncidents(emitter, condition) {
      const prefix = `${emitter}:`
      const suffix = `:${condition}`
      const result: Array<{ subject: string; recipient: string }> = []
      for (const [key, value] of openIncidents.entries()) {
        if (key.startsWith(prefix) && key.endsWith(suffix)) {
          result.push(value)
        }
      }
      return result
    },
  }
  return { api, sent, openIncidents }
}

describe("createWatchlistPoller (#38449)", () => {
  test("first poll seeds without flooding; new comment routes to owner and to @chief/chat only with --operator", async () => {
    const dir = makeTempDir("tribe-watch-poll-")
    const watchlistPath = join(dir, "github-watchlist.json")
    addGitHubWatchEntry(watchlistPath, { target: "ahpio/ahpd#463", owner: "@dev/15", operatorFollows: false })
    addGitHubWatchEntry(watchlistPath, { target: "oven-sh/bun#999", owner: "@dev/9", operatorFollows: true })

    const cursorStore = openGitHubWatchlistCursorStore({ stateDir: dir })
    const { api, sent } = makeFakeApi()
    let nowMs = Date.parse("2026-11-25T05:00:00Z")

    let ahpdComments: GitHubCommentPayload[] = [
      {
        id: 10,
        body: "existing comment",
        html_url: "https://github.com/ahpio/ahpd/pull/463#issuecomment-10",
        user: { login: "alice" },
      },
    ]
    let bunComments: GitHubCommentPayload[] = [
      {
        id: 20,
        body: "old bun comment",
        html_url: "https://github.com/oven-sh/bun/issues/999#issuecomment-20",
        user: { login: "bob" },
      },
    ]
    let ahpdReviews: GitHubReviewPayload[] = []
    let ahpdIssue: GitHubIssuePayload = {
      number: 463,
      title: "fix backend start",
      state: "open",
      html_url: "https://github.com/ahpio/ahpd/pull/463",
      closed_at: null,
      pull_request: { merged_at: null },
    }
    const bunIssue: GitHubIssuePayload = {
      number: 999,
      title: "bun bug",
      state: "open",
      html_url: "https://github.com/oven-sh/bun/issues/999",
      closed_at: null,
    }

    const poller = createWatchlistPoller({
      watchlistPath,
      cursorStore,
      api,
      pollHealth: createPollHealth(() => nowMs),
      now: () => nowMs,
      fetchJson: async <T>(path: string): Promise<WatchlistFetchResult<T>> => {
        if (path === "/repos/ahpio/ahpd/issues/463") {
          return { data: ahpdIssue as T, rateLimitRemaining: 4900, rateLimitTotal: 5000 }
        }
        if (path === "/repos/ahpio/ahpd/issues/463/comments?per_page=100") {
          return { data: ahpdComments as T, rateLimitRemaining: 4899, rateLimitTotal: 5000 }
        }
        if (path === "/repos/ahpio/ahpd/pulls/463/reviews?per_page=100") {
          return { data: ahpdReviews as T, rateLimitRemaining: 4898, rateLimitTotal: 5000 }
        }
        if (path === "/repos/ahpio/ahpd/pulls/463/comments?per_page=100") {
          return { data: [] as T, rateLimitRemaining: 4897, rateLimitTotal: 5000 }
        }
        if (path === "/repos/oven-sh/bun/issues/999") {
          return { data: bunIssue as T, rateLimitRemaining: 4896, rateLimitTotal: 5000 }
        }
        if (path === "/repos/oven-sh/bun/issues/999/comments?per_page=100") {
          return { data: bunComments as T, rateLimitRemaining: 4895, rateLimitTotal: 5000 }
        }
        throw new Error(`unexpected path: ${path}`)
      },
    })

    // First poll: seeds cursors, sends zero notifications
    const first = await poller.pollOnce()
    expect(first.notificationsSent).toBe(0)
    expect(sent).toHaveLength(0)

    // Add one new comment on each item, plus a review and merge on ahpd#463
    nowMs += 60_000
    ahpdComments = [
      ...ahpdComments,
      {
        id: 11,
        body: "LGTM shipping",
        html_url: "https://github.com/ahpio/ahpd/pull/463#issuecomment-11",
        user: { login: "maintainer" },
      },
    ]
    ahpdReviews = [
      {
        id: 31,
        state: "APPROVED",
        body: "Looks great",
        html_url: "https://github.com/ahpio/ahpd/pull/463#pullrequestreview-31",
        user: { login: "maintainer" },
      },
    ]
    ahpdIssue = {
      ...ahpdIssue,
      state: "closed",
      closed_at: "2026-11-25T05:00:30Z",
      pull_request: { merged_at: "2026-11-25T05:00:30Z" },
    }
    bunComments = [
      ...bunComments,
      {
        id: 21,
        body: "Fixed in canary",
        html_url: "https://github.com/oven-sh/bun/issues/999#issuecomment-21",
        user: { login: "jarred" },
      },
    ]

    const second = await poller.pollOnce()
    expect(second.errors).toHaveLength(0)

    // ahpd#463 (operatorFollows: false): merge + comment + review -> ONLY @dev/15, never @chief/chat
    const ahpdRows = sent.filter((s) => s.content.includes("ahpio/ahpd#463"))
    expect(ahpdRows).toHaveLength(3)
    expect(ahpdRows.every((s) => s.recipient === "@dev/15")).toBe(true)
    expect(ahpdRows.some((s) => s.content.includes("merged:"))).toBe(true)
    expect(ahpdRows.some((s) => s.content.includes("comment by maintainer: LGTM shipping"))).toBe(true)
    expect(ahpdRows.some((s) => s.content.includes("review (approved) by maintainer"))).toBe(true)

    // bun#999 (operatorFollows: true): 1 comment -> 1 row to @dev/9 AND 1 row to @chief/chat
    const bunRows = sent.filter((s) => s.content.includes("oven-sh/bun#999"))
    expect(bunRows).toHaveLength(2)
    expect(bunRows.map((s) => s.recipient).sort()).toEqual(["@chief/chat", "@dev/9"])
    expect(bunRows[0]?.content).toContain("Fixed in canary")
  })

  test("expires items closed or merged more than 14 days ago, logs once, and notifies owner", async () => {
    const dir = makeTempDir("tribe-watch-expiry-")
    const watchlistPath = join(dir, "github-watchlist.json")
    addGitHubWatchEntry(watchlistPath, { target: "ahpio/ahpd#100", owner: "@dev/15", operatorFollows: false })

    const cursorStore = openGitHubWatchlistCursorStore({ stateDir: dir })
    const { api, sent } = makeFakeApi()
    const logs: string[] = []
    const nowMs = Date.parse("2026-11-25T05:00:00Z")

    const poller = createWatchlistPoller({
      watchlistPath,
      cursorStore,
      api,
      pollHealth: createPollHealth(() => nowMs),
      now: () => nowMs,
      log: { info: (m) => logs.push(m) },
      fetchJson: async <T>(): Promise<WatchlistFetchResult<T>> => ({
        data: {
          number: 100,
          title: "old closed PR",
          state: "closed",
          html_url: "https://github.com/ahpio/ahpd/pull/100",
          closed_at: "2026-11-01T12:00:00Z",
          pull_request: { merged_at: "2026-11-01T12:00:00Z" },
        } as T,
        rateLimitRemaining: 4900,
        rateLimitTotal: 5000,
      }),
    })

    const res = await poller.pollOnce()
    expect(res.expiredTargets).toEqual(["ahpio/ahpd#100"])
    expect(readGitHubWatchlist(watchlistPath).entries).toHaveLength(0)
    expect(logs).toContain("github watchlist: stopped watching ahpio/ahpd#100: closed 2026-11-01")
    expect(sent).toHaveLength(1)
    expect(sent[0]?.recipient).toBe("@dev/15")
    expect(sent[0]?.content).toBe("stopped watching ahpio/ahpd#100: closed 2026-11-01")
  })

  test("honours X-Poll-Interval between ticks", async () => {
    const dir = makeTempDir("tribe-watch-interval-")
    const watchlistPath = join(dir, "github-watchlist.json")
    addGitHubWatchEntry(watchlistPath, { target: "ahpio/ahpd#463", owner: "@dev/15" })

    const cursorStore = openGitHubWatchlistCursorStore({ stateDir: dir })
    const { api } = makeFakeApi()
    let nowMs = Date.parse("2026-11-25T05:00:00Z")
    let calls = 0

    const poller = createWatchlistPoller({
      watchlistPath,
      cursorStore,
      api,
      pollHealth: createPollHealth(() => nowMs),
      now: () => nowMs,
      fetchJson: async <T>(path: string): Promise<WatchlistFetchResult<T>> => {
        calls++
        if (path.endsWith("/issues/463")) {
          return {
            data: {
              number: 463,
              title: "t",
              state: "open",
              html_url: "https://github.com/ahpio/ahpd/issues/463",
              closed_at: null,
            } as T,
            pollIntervalSec: 120,
            rateLimitRemaining: 4900,
            rateLimitTotal: 5000,
          }
        }
        return { data: [] as T, rateLimitRemaining: 4899, rateLimitTotal: 5000 }
      },
    })

    await poller.pollOnce()
    expect(calls).toBe(2)

    // 60s later (< 120s X-Poll-Interval): skipped
    nowMs += 60_000
    const skipped = await poller.pollOnce()
    expect(skipped.skipped).toBe(true)
    expect(calls).toBe(2)

    // 120s later: polls again
    nowMs += 60_000
    const resumed = await poller.pollOnce()
    expect(resumed.skipped).toBe(false)
    expect(calls).toBe(4)
  })

  test("403 rate limit raises poll-failed incident and clears it on recovery; <500 remaining also raises before hitting 0", async () => {
    const dir = makeTempDir("tribe-watch-ratelimit-")
    const watchlistPath = join(dir, "github-watchlist.json")
    addGitHubWatchEntry(watchlistPath, { target: "ahpio/ahpd#463", owner: "@dev/15" })

    const cursorStore = openGitHubWatchlistCursorStore({ stateDir: dir })
    const { api, sent, openIncidents } = makeFakeApi()
    let nowMs = Date.parse("2026-11-25T05:00:00Z")
    let mode: "rate-limit-403" | "low-quota" | "healthy" = "rate-limit-403"

    const poller = createWatchlistPoller({
      watchlistPath,
      cursorStore,
      api,
      pollHealth: createPollHealth(() => nowMs),
      now: () => nowMs,
      fetchJson: async <T>(path: string): Promise<WatchlistFetchResult<T>> => {
        if (mode === "rate-limit-403") {
          const err = new Error("GitHub API 403: API rate limit exceeded")
          Object.assign(err, { rateLimit: { kind: "primary", resetAtMs: nowMs + 10 * 60_000 } satisfies RateLimitInfo })
          throw err
        }
        const remaining = mode === "low-quota" ? 420 : 4950
        if (path.endsWith("/issues/463")) {
          return {
            data: {
              number: 463,
              title: "t",
              state: "open",
              html_url: "https://github.com/ahpio/ahpd/issues/463",
              closed_at: null,
            } as T,
            rateLimitRemaining: remaining,
            rateLimitTotal: 5000,
          }
        }
        return { data: [] as T, rateLimitRemaining: remaining, rateLimitTotal: 5000 }
      },
    })

    // 1. 403 rate limit raises incident
    await poller.pollOnce()
    const incidentKey = `${GITHUB_WATCHLIST_INCIDENT_EMITTER}:${GITHUB_WATCHLIST_INCIDENT_SUBJECT}:${GITHUB_WATCHLIST_INCIDENT_CONDITION}`
    expect(openIncidents.has(incidentKey)).toBe(true)
    expect(sent.at(-1)?.recipient).toBe("@chief")
    expect(sent.at(-1)?.incident?.active).toBe(true)

    // 2. Advance past reset pause -> recover with healthy quota -> incident clears
    nowMs += 11 * 60_000
    mode = "healthy"
    await poller.pollOnce()
    expect(openIncidents.has(incidentKey)).toBe(false)
    expect(sent.at(-1)?.incident?.active).toBe(false)

    // 3. Remaining drops under 500 (420) -> raises incident BEFORE hitting 0
    nowMs += 60_000
    mode = "low-quota"
    await poller.pollOnce()
    expect(openIncidents.has(incidentKey)).toBe(true)
    expect(sent.at(-1)?.content).toContain("420/5000")
    expect(sent.at(-1)?.incident?.active).toBe(true)

    // 4. Quota recovers -> clears incident again
    nowMs += 60_000
    mode = "healthy"
    await poller.pollOnce()
    expect(openIncidents.has(incidentKey)).toBe(false)
    expect(GITHUB_WATCHLIST_OPERATOR_SEAT).toBe("@chief/chat")
  })
})
