/**
 * @failure A GitHub MONITOR-rail 401 ("Bad credentials") is bucketed as a
 *   generic "HTTP 401" with no actionable guidance, so a daemon-side monitor
 *   credential problem is indistinguishable from a transient network/integration
 *   blip — @ci and sitrep mis-read it as an integration failure (km 20593).
 *   AND: during a rate-limit burst or network outage the poller keeps hammering
 *   every repo every 60s and re-emits an identical "N/N repos failed" warn each
 *   tick — a warn flood that sprays raw API payloads into the daemon log and
 *   (post-defang, as `[n]` lines) into member panes
 *   (km ci-github-rate-limits + tribe-server-health-rollout, 2026-07-02).
 * @level L2 — classification + pause/backoff state machine + warn dedup.
 * @consumer summarizePollErrors / createPollHealth / detectRateLimit in github-plugin.ts
 */
import type { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { createTribeContext } from "./context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import {
  createPollHealth,
  createWorkflowIncidentRouter,
  detectRateLimit,
  formatEvent,
  formatGitHubPluginStartLine,
  formatLateEventsWarning,
  GITHUB_LATE_HORIZON_MS,
  GITHUB_WORKFLOW_INCIDENT_CONDITION,
  GITHUB_WORKFLOW_INCIDENT_EMITTER,
  gitHubTokenSourceLabel,
  partitionLateEvents,
  rateLimitInfoOf,
  resolveWorkflowIncidentOwner,
  resolveWorkflowIncidentWatchers,
  selectNewEvents,
  summarizePollErrors,
  type GitHubEvent,
  type PollError,
  type RateLimitInfo,
  type WorkflowIncidentRouterApi,
  type WorkflowRun,
} from "./github-plugin.ts"
import { readOpenIncidents, sendMessage } from "./messaging.ts"

const auth401: PollError = { repo: "beorn/bearly", message: "GitHub API 401: Bad credentials" }
const forbidden403: PollError = { repo: "beorn/termless", message: "GitHub API 403: Resource not accessible" }
const rateLimited: PollError = { repo: "beorn/km", message: "GitHub API 403: API rate limit exceeded" }
const network: PollError = { repo: "beorn/ag", message: "fetch failed: ECONNRESET" }
const server500: PollError = { repo: "beorn/kimmi", message: "GitHub API 500: server error" }

describe("summarizePollErrors — monitor-rail auth classification (20593)", () => {
  test("a 401 is bucketed as auth-401, distinct from the generic HTTP/network buckets", () => {
    const out = summarizePollErrors([auth401], 4999, 5000, "GITHUB_TOKEN env var")
    expect(out).toContain("auth-401×1")
    expect(out).not.toContain("HTTP 401")
    expect(out).not.toContain("network/fetch")
  })

  test("a 401 emits an actionable credential-owner note naming the token source", () => {
    const out = summarizePollErrors([auth401], 4999, 5000, "GITHUB_TOKEN env var")
    expect(out).toContain("token source: GITHUB_TOKEN env var")
    expect(out).toMatch(/refresh with/i)
    expect(out).toContain("credential rejected")
  })

  test("a 401 is framed as monitor-rail-only — git SSH + integrator unaffected (not a CI failure)", () => {
    const out = summarizePollErrors([auth401], 4999, 5000)
    expect(out).toMatch(/MONITOR-RAIL/)
    expect(out).toContain("git SSH + integrator UNAFFECTED")
  })

  test("a non-rate-limit 403 is bucketed as auth-403 (token lacks scope) and gets the credential note", () => {
    const out = summarizePollErrors([forbidden403], 4999, 5000, "`gh auth token` (gh CLI login)")
    expect(out).toContain("auth-403×1")
    expect(out).toContain("token source: `gh auth token` (gh CLI login)")
  })

  test("a 403 rate-limit stays classified rate-limited — NOT auth, NOT a credential problem", () => {
    const out = summarizePollErrors([rateLimited], 0, 5000)
    expect(out).toContain("rate-limited×1")
    expect(out).not.toContain("auth-403")
    expect(out).not.toContain("credential rejected")
  })

  test("non-auth failures (network, 500) do NOT get the credential note", () => {
    const out = summarizePollErrors([network, server500], 4999, 5000)
    expect(out).toContain("network/fetch×1")
    expect(out).toContain("HTTP 500×1")
    expect(out).not.toContain("credential rejected")
    expect(out).not.toMatch(/refresh with/i)
  })

  test("a mixed batch (auth + network) surfaces both buckets and still appends the credential note", () => {
    const out = summarizePollErrors([auth401, network], 4999, 5000, "GITHUB_TOKEN env var")
    expect(out).toContain("auth-401×1")
    expect(out).toContain("network/fetch×1")
    expect(out).toContain("credential rejected")
  })
})

describe("summarizePollErrors — sample sanitization (payload spray)", () => {
  test("a multi-line raw API payload in the sample collapses to one line", () => {
    const sprayed: PollError = {
      repo: "beorn/km",
      message: 'GitHub API 403: {\n  "message": "API rate limit exceeded",\n  "documentation_url": "..."\n}',
    }
    const out = summarizePollErrors([sprayed], 0, 5000)
    expect(out).not.toContain("\n")
    expect(out).toContain("API rate limit exceeded")
  })
})

describe("detectRateLimit / rateLimitInfoOf — 403/429 classification", () => {
  test("403 + rate-limit body = primary, with resetAtMs from x-ratelimit-reset", () => {
    const resetSec = 1_900_000_000
    const res = new Response("", {
      status: 403,
      headers: { "x-ratelimit-reset": String(resetSec), "x-ratelimit-remaining": "0" },
    })
    const info = detectRateLimit(res, "API rate limit exceeded for user")
    expect(info).toEqual({ kind: "primary", resetAtMs: resetSec * 1000 })
  })

  test("403 with remaining=0 counts as rate limit even without the body phrase", () => {
    const res = new Response("", { status: 403, headers: { "x-ratelimit-remaining": "0" } })
    expect(detectRateLimit(res, "Forbidden")?.kind).toBe("primary")
  })

  test("429 = secondary, resetAtMs from retry-after seconds", () => {
    const res = new Response("", { status: 429, headers: { "retry-after": "60" } })
    const info = detectRateLimit(res, "too many requests")
    expect(info?.kind).toBe("secondary")
    expect(info?.resetAtMs).toBeGreaterThan(Date.now())
  })

  test("plain 403 scope rejection is NOT a rate limit; plain errors carry no info", () => {
    const res = new Response("", { status: 403, headers: { "x-ratelimit-remaining": "4999" } })
    expect(detectRateLimit(res, "Resource not accessible by integration")).toBeNull()
    expect(rateLimitInfoOf(new Error("GitHub API 500: boom"))).toBeNull()
  })

  test("rateLimitInfoOf reads the info a ghFetch error carries", () => {
    const err = Object.assign(new Error("GitHub API 403: rate limit"), {
      rateLimit: { kind: "primary", resetAtMs: 123 } satisfies RateLimitInfo,
    })
    expect(rateLimitInfoOf(err)).toEqual({ kind: "primary", resetAtMs: 123 })
  })
})

describe("createPollHealth — pause/backoff gate + warn dedup (2026-07-02 flood)", () => {
  const MIN = 60_000
  const fail = (repo: string): PollError => ({ repo, message: "fetch failed: ECONNRESET" })
  const allFail = (n: number): PollError[] => Array.from({ length: n }, (_, i) => fail(`beorn/repo${i}`))

  function clock(startMs = 10_000_000) {
    let t = startMs
    return { now: () => t, advance: (ms: number) => (t += ms) }
  }

  test("an unchanged failure signature warns once, then stays silent until the 10min heartbeat", () => {
    const c = clock()
    const health = createPollHealth(c.now)
    const errors = [fail("beorn/km")]
    const first = health.report("events", { errors, repoCount: 23, rateLimit: null })
    expect(first.warn).toContain("1/23 repos failed")

    // Same signature every 60s tick — all suppressed
    for (let i = 0; i < 9; i++) {
      c.advance(MIN)
      expect(health.report("events", { errors, repoCount: 23, rateLimit: null }).warn).toBeNull()
    }

    // Heartbeat re-warn carries the suppressed count
    c.advance(2 * MIN)
    const heartbeat = health.report("events", { errors, repoCount: 23, rateLimit: null })
    expect(heartbeat.warn).toContain("9 identical warns suppressed")
  })

  test("a changed failure signature warns immediately (no dedup across causes)", () => {
    const c = clock()
    const health = createPollHealth(c.now)
    health.report("events", { errors: [fail("beorn/km")], repoCount: 23, rateLimit: null })
    c.advance(MIN)
    const changed = health.report("events", {
      errors: [{ repo: "beorn/km", message: "GitHub API 401: Bad credentials" }],
      repoCount: 23,
      rateLimit: null,
    })
    expect(changed.warn).toContain("auth-401")
  })

  test("recovery after a warned state emits one info line, then silence", () => {
    const c = clock()
    const health = createPollHealth(c.now)
    health.report("events", { errors: [fail("beorn/km")], repoCount: 23, rateLimit: null })
    c.advance(MIN)
    const recovered = health.report("events", { errors: [], repoCount: 23, rateLimit: null })
    expect(recovered.info).toContain("recovered")
    expect(recovered.warn).toBeNull()
    const quiet = health.report("events", { errors: [], repoCount: 23, rateLimit: null })
    expect(quiet.info).toBeNull()
  })

  test("legs dedup independently — a workflows warn is not suppressed by an events warn", () => {
    const c = clock()
    const health = createPollHealth(c.now)
    health.report("events", { errors: [fail("beorn/km")], repoCount: 23, rateLimit: null })
    const wf = health.report("workflows", { errors: [fail("beorn/km")], repoCount: 23, rateLimit: null })
    expect(wf.warn).toContain("workflows")
  })

  test("ALL repos failing = outage: escalating backoff 2m -> 5m -> 15m, gate skips while paused", () => {
    const c = clock()
    const health = createPollHealth(c.now)

    const first = health.report("events", { errors: allFail(23), repoCount: 23, rateLimit: null })
    expect(first.warn).toContain("23/23 repos failed (ALL)")
    expect(first.warn).toContain("backing off 2min")

    // Paused: gate skips
    expect(health.checkGate().skip).toBe(true)
    c.advance(2 * MIN + 1)
    const resumed = health.checkGate()
    expect(resumed.skip).toBe(false)
    expect(resumed.info).toContain("resumed after outage pause")

    // Still down — escalate
    const second = health.report("events", { errors: allFail(23), repoCount: 23, rateLimit: null })
    expect(second.warn).toContain("backing off 5min")
    c.advance(5 * MIN + 1)
    health.checkGate()
    const third = health.report("events", { errors: allFail(23), repoCount: 23, rateLimit: null })
    expect(third.warn).toContain("backing off 15min")

    // Cap: stays at 15min
    c.advance(15 * MIN + 1)
    health.checkGate()
    const fourth = health.report("events", { errors: allFail(23), repoCount: 23, rateLimit: null })
    expect(fourth.warn).toContain("backing off 15min")

    // Network back — recovery resets the ladder
    c.advance(15 * MIN + 1)
    health.checkGate()
    expect(health.report("events", { errors: [], repoCount: 23, rateLimit: null }).info).toContain("recovered")
    const fresh = health.report("events", { errors: allFail(23), repoCount: 23, rateLimit: null })
    expect(fresh.warn).toContain("backing off 2min")
  })

  test("rate limit pauses ALL polling until reset (+slack), warns once, resumes with a note", () => {
    const c = clock()
    const health = createPollHealth(c.now)
    const rl: RateLimitInfo = { kind: "primary", resetAtMs: c.now() + 30 * MIN }

    const hit = health.report("events", { errors: [fail("beorn/km")], repoCount: 23, rateLimit: rl })
    expect(hit.warn).toContain("PAUSING all github polling")
    expect(hit.warn).toMatch(/for 3[01]min/) // 30min reset + 30s slack, rounded

    // Same tick, other leg already in flight: silent (no double warn)
    const other = health.report("workflows", { errors: [fail("beorn/km")], repoCount: 23, rateLimit: rl })
    expect(other.warn).toBeNull()

    // Both legs gated for the whole window
    c.advance(29 * MIN)
    expect(health.checkGate().skip).toBe(true)
    c.advance(2 * MIN)
    const resumed = health.checkGate()
    expect(resumed.skip).toBe(false)
    expect(resumed.info).toContain("resumed after rate-limit pause")
  })

  test("a stale/past reset header floors the pause at 5min — no warn-per-minute loop", () => {
    const c = clock()
    const health = createPollHealth(c.now)
    const stale: RateLimitInfo = { kind: "primary", resetAtMs: c.now() - 10 * MIN }
    health.report("events", { errors: [fail("beorn/km")], repoCount: 23, rateLimit: stale })
    c.advance(4 * MIN)
    expect(health.checkGate().skip).toBe(true)
    c.advance(2 * MIN)
    expect(health.checkGate().skip).toBe(false)
  })

  test("missing reset header uses the 15min default pause", () => {
    const c = clock()
    const health = createPollHealth(c.now)
    health.report("events", {
      errors: [fail("beorn/km")],
      repoCount: 23,
      rateLimit: { kind: "secondary", resetAtMs: null },
    })
    c.advance(14 * MIN)
    expect(health.checkGate().skip).toBe(true)
    c.advance(2 * MIN)
    expect(health.checkGate().skip).toBe(false)
  })
})

describe("gitHubTokenSourceLabel — names the config source, never the token (20593)", () => {
  test("reports GITHUB_TOKEN env when set; gh CLI otherwise — and never leaks the value", () => {
    const saved = process.env.GITHUB_TOKEN
    try {
      process.env.GITHUB_TOKEN = "ghp_secret_should_not_appear"
      const envLabel = gitHubTokenSourceLabel()
      expect(envLabel).toContain("GITHUB_TOKEN")
      expect(envLabel).not.toContain("ghp_secret_should_not_appear")

      delete process.env.GITHUB_TOKEN
      expect(gitHubTokenSourceLabel()).toMatch(/gh auth token|gh CLI/i)
    } finally {
      if (saved === undefined) delete process.env.GITHUB_TOKEN
      else process.env.GITHUB_TOKEN = saved
    }
  })
})

describe("selectNewEvents / formatEvent — a late push must not read as news (2026-09-04 replay)", () => {
  const push = (id: string, createdAt: string): GitHubEvent => ({
    id,
    type: "PushEvent",
    actor: { login: "beorn" },
    repo: { name: "beorn/yrd" },
    payload: { ref: "refs/heads/main", before: "1234567abcdef", head: "abcdef0123456", size: 1, distinct_size: 1 },
    created_at: createdAt,
  })

  test("the push line carries the push's own time, so a row delivered late is dated", () => {
    expect(formatEvent(push("1", "2026-09-02T22:34:59Z"), ["push"])).toEqual({
      kind: "notice",
      type: "push",
      line: "beorn/yrd: beorn pushed 1 commit to main at 2026-09-02T22:34:59Z",
      url: "https://github.com/beorn/yrd/compare/1234567...abcdef0",
    })
  })

  test("events newer than the cursor are delivered, newest first, with no cap", () => {
    const page = [push("5", "t5"), push("4", "t4"), push("3", "t3"), push("2", "t2"), push("1", "t1")]
    expect(selectNewEvents(page, "1")).toEqual({ kind: "deliver", events: page.slice(0, 4) })
  })

  test("a cursor that fell off the page is a resync, never the whole page delivered as news", () => {
    const page = [push("5", "t5"), push("4", "t4")]
    expect(selectNewEvents(page, "gone")).toEqual({ kind: "resync", skipped: page })
  })

  test("an empty page with a cursor delivers nothing and does not resync", () => {
    expect(selectNewEvents([], "1")).toEqual({ kind: "deliver", events: [] })
  })
})

describe("partitionLateEvents — GitHub materializes some events 1-2 days late (24154)", () => {
  const push = (id: string, createdAt: string): GitHubEvent => ({
    id,
    type: "PushEvent",
    actor: { login: "beorn" },
    repo: { name: "beorn/hh" },
    payload: { ref: "refs/heads/main", before: "1234567abcdef", head: "abcdef0123456", size: 1, distinct_size: 1 },
    created_at: createdAt,
  })
  const NOW = Date.parse("2026-09-05T04:09:00Z")
  const HOUR = 60 * 60 * 1000

  test("an event within the horizon is kept fresh, one well past it is dropped as late", () => {
    const freshEvent = push("3", new Date(NOW - HOUR / 2).toISOString())
    const staleEvent = push("2", new Date(NOW - 2 * HOUR).toISOString())
    expect(partitionLateEvents([freshEvent, staleEvent], NOW, HOUR)).toEqual({
      fresh: [freshEvent],
      late: [staleEvent],
    })
  })

  test("an event exactly at the horizon is fresh, one millisecond older is late", () => {
    const atHorizon = push("1", new Date(NOW - HOUR).toISOString())
    const pastHorizon = push("2", new Date(NOW - HOUR - 1).toISOString())
    expect(partitionLateEvents([atHorizon, pastHorizon], NOW, HOUR)).toEqual({
      fresh: [atHorizon],
      late: [pastHorizon],
    })
  })

  test("GITHUB_LATE_HORIZON_MS defaults the horizon to one hour", () => {
    expect(GITHUB_LATE_HORIZON_MS).toBe(HOUR)
  })
})

describe("formatLateEventsWarning — names the count and the created_at range (24154)", () => {
  const push = (id: string, createdAt: string): GitHubEvent => ({
    id,
    type: "PushEvent",
    actor: { login: "beorn" },
    repo: { name: "beorn/hh" },
    payload: { ref: "refs/heads/main", before: "1234567abcdef", head: "abcdef0123456", size: 1, distinct_size: 1 },
    created_at: createdAt,
  })

  test("the warn line names the count, the repo, and the oldest..newest created_at range", () => {
    const late = [push("3", "2026-09-03T05:11:29Z"), push("2", "2026-09-02T10:00:00Z")]
    expect(formatLateEventsWarning("beorn/hh", late)).toBe(
      "github events: 2 late events for beorn/hh (2026-09-02T10:00:00Z..2026-09-03T05:11:29Z) not broadcast; GitHub materialized them late",
    )
  })

  // LIVE SPECIMEN 2026-09-07 15:43:00Z, from the daemon this fix runs in:
  //   github events: 2 late events for beorn/hh
  //   (2026-09-05T17:40:04Z..2026-09-05T16:07:56Z) not broadcast; ...
  // The range ran BACKWARDS. formatLateEventsWarning trusted POSITION —
  // late[0] as newest, last as oldest — on the strength of its own comment,
  // "late is newest-first, matching selectNewEvents' order". That holds by
  // ID, which is what selectNewEvents sorts by, and this whole feature exists
  // because GitHub returns ids ascending while created_at does NOT. So the
  // only input this code ever sees in production is the one that breaks it.
  //
  // The case above cannot catch this: its fixture is monotonic in BOTH id and
  // time, so position and chronology agree and the bug is invisible. This one
  // is deliberately non-monotonic — id "3" is the OLDER event — which is the
  // shape the API actually returns.
  test("the range reads oldest..newest even when created_at runs against id order", () => {
    const late = [push("3", "2026-09-05T16:07:56Z"), push("2", "2026-09-05T17:40:04Z")]
    expect(formatLateEventsWarning("beorn/hh", late)).toBe(
      "github events: 2 late events for beorn/hh (2026-09-05T16:07:56Z..2026-09-05T17:40:04Z) not broadcast; GitHub materialized them late",
    )
  })

  test("refuses an empty list rather than printing an undefined range", () => {
    expect(() => formatLateEventsWarning("beorn/hh", [])).toThrow("requires at least one late event")
  })
})

describe("formatEvent — the Events API PR payload carries no title or html_url (2026-09-05 'undefined undefined')", () => {
  // Measured 2026-09-05 with `gh api repos/beorn/silvery/events`: every
  // PullRequestEvent payload carried `pull_request` keys base, head, id,
  // number, url and nothing else, and the daemon announced
  // "[pr] beorn/silvery: beorn opened PR #16: undefined undefined".
  const slimPr = (id: string, action: string, number: number): GitHubEvent => ({
    id,
    type: "PullRequestEvent",
    actor: { login: "beorn" },
    repo: { name: "beorn/silvery" },
    payload: {
      action,
      number,
      pull_request: {
        id: 1,
        number,
        url: `https://api.github.com/repos/beorn/silvery/pulls/${number}`,
        head: { ref: "fix/ci-termless-dependency", sha: "a", repo: null },
        base: { ref: "main", sha: "b", repo: null },
      },
    },
    created_at: "2026-09-05T00:01:44Z",
  })

  test("a slim PR payload announces number and branches, derives the PR URL, and never prints undefined", () => {
    const out = formatEvent(slimPr("14465153674", "opened", 16), ["pull_request"])
    expect(out).toEqual({
      kind: "notice",
      type: "pr",
      line: "[pr] beorn/silvery: beorn opened PR #16 (fix/ci-termless-dependency → main)",
      url: "https://github.com/beorn/silvery/pull/16",
    })
    expect(JSON.stringify(out)).not.toMatch(/undefined|null/)
  })

  test("a full PR object (webhook shape) appends the title and keeps its own html_url", () => {
    const event = slimPr("2", "merged", 16)
    Object.assign(event.payload.pull_request as Record<string, unknown>, {
      title: "fix(ci): pin termless",
      html_url: "https://github.com/beorn/silvery/pull/16",
    })
    expect(formatEvent(event, ["pull_request"])).toEqual({
      kind: "notice",
      type: "pr",
      line: "[pr] beorn/silvery: beorn merged PR #16 (fix/ci-termless-dependency → main): fix(ci): pin termless",
      url: "https://github.com/beorn/silvery/pull/16",
    })
  })

  test("a PR payload with no number is malformed and says so, rather than announcing PR #undefined", () => {
    const event = slimPr("3", "opened", 16)
    event.payload = { action: "opened" }
    expect(formatEvent(event, ["pull_request"])).toEqual({
      kind: "malformed",
      reason: "PullRequestEvent 3 on beorn/silvery carries no pull request number; nothing announced",
    })
  })

  test("a review on a slim PR announces the state and number and derives the PR URL", () => {
    const event: GitHubEvent = {
      ...slimPr("4", "created", 16),
      type: "PullRequestReviewEvent",
      payload: { action: "created", review: { state: "approved" }, pull_request: { number: 16 } },
    }
    expect(formatEvent(event, ["pull_request"])).toEqual({
      kind: "notice",
      type: "pr",
      line: "[review] beorn/silvery: beorn approved review on PR #16",
      url: "https://github.com/beorn/silvery/pull/16",
    })
  })

  test("an issue comment keeps the full issue shape the API does deliver", () => {
    const event: GitHubEvent = {
      ...slimPr("5", "created", 16),
      type: "IssueCommentEvent",
      payload: {
        action: "created",
        issue: { number: 7, title: "flaky test", html_url: "https://github.com/beorn/silvery/issues/7" },
        comment: {
          body: "first line\nsecond line",
          html_url: "https://github.com/beorn/silvery/issues/7#issuecomment-1",
        },
      },
    }
    expect(formatEvent(event, ["issues"])).toEqual({
      kind: "notice",
      type: "issue",
      line: "[issue-comment] beorn/silvery: beorn on #7: first line",
      url: "https://github.com/beorn/silvery/issues/7#issuecomment-1",
    })
  })

  test("an unsubscribed type is reported as such, distinct from a malformed payload", () => {
    expect(formatEvent(slimPr("6", "opened", 16), ["push"])).toEqual({ kind: "unsubscribed" })
    expect(formatEvent({ ...slimPr("7", "opened", 16), type: "WatchEvent" }, ["pull_request"])).toEqual({
      kind: "unsubscribed",
    })
  })
})

describe("createWorkflowIncidentRouter — per-branch incident routing on main and release tags", () => {
  const OWNER = "@dev/fixer"
  let dir: string
  let db: Database
  let stmts: TribeStatements

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "github-workflow-incident-"))
    db = openDatabase(join(dir, "tribe.db"))
    stmts = createStatements(db)
  })
  afterEach(() => {
    db.close()
    // raw-delete-allow: test cleanup of mkdtempSync fixture directory
    rmSync(dir, { force: true, recursive: true })
  })

  function daemonApi(): {
    api: WorkflowIncidentRouterApi
    broadcasts: Array<{ content: string; type: string; classification: unknown }>
  } {
    const daemonCtx = createTribeContext({
      claudeSessionId: null,
      claudeSessionName: null,
      db,
      domains: [],
      initialName: "daemon",
      sessionId: "sess-daemon",
      sessionRole: "daemon",
      stmts,
    })
    const broadcasts: Array<{ content: string; type: string; classification: unknown }> = []
    const api: WorkflowIncidentRouterApi = {
      broadcast(content, type, beadId, classification) {
        broadcasts.push({ content, type, classification })
        sendMessage(daemonCtx, "*", content, type, beadId, undefined, "broadcast", classification ?? {})
      },
      listOpenIncidents: (emitter, condition) => readOpenIncidents(stmts, emitter, condition),
      send(recipient, content, type, beadId, classification, incident) {
        sendMessage(
          daemonCtx,
          recipient,
          content,
          type,
          beadId,
          undefined,
          recipient === "*" ? "broadcast" : "direct",
          classification ?? {},
          incident === undefined ? {} : { incident },
        )
      },
    }
    return { api, broadcasts }
  }

  const makeRun = (
    overrides: Partial<WorkflowRun> & Pick<WorkflowRun, "conclusion" | "head_branch" | "name" | "run_number">,
  ): WorkflowRun => ({
    id: overrides.run_number,
    status: "completed",
    html_url: `https://github.com/beorn/yrd/actions/runs/${overrides.run_number}`,
    head_sha: "abcdef0123456789",
    run_attempt: 1,
    created_at: "2026-10-18T22:00:00Z",
    updated_at: "2026-10-18T22:01:00Z",
    actor: { login: "beorn" },
    ...overrides,
  })

  const ballsFor = (recipient: string): Array<{ request_id: string; message_id: string; summary: string | null }> =>
    stmts.selectPendingForRecipient.all({ $recipient: recipient }) as Array<{
      request_id: string
      message_id: string
      summary: string | null
    }>

  const openIncidents = () =>
    readOpenIncidents(stmts, GITHUB_WORKFLOW_INCIDENT_EMITTER, GITHUB_WORKFLOW_INCIDENT_CONDITION)

  test("per-branch subject (<repo>/<workflow>@<branch>): main fail, repeat upsert, tag fail, reload, tag success leaves main open, main success clears main, and ordinary green sends nothing", () => {
    const { api, broadcasts } = daemonApi()
    const router = createWorkflowIncidentRouter(api, { incidentOwner: OWNER })

    // 1. main fail opens github:beorn/yrd/ci@main:failing and wakes owner.
    router.handleRun("beorn/yrd", makeRun({ name: "ci", run_number: 752, conclusion: "failure", head_branch: "main" }))
    const firstMainBall = ballsFor(OWNER)
    expect(firstMainBall).toHaveLength(1)
    expect(firstMainBall[0]?.request_id).toBe("github:beorn/yrd/ci@main:failing")

    // 2. Repeat failure on main upserts the standing ball without waking again.
    router.handleRun("beorn/yrd", makeRun({ name: "ci", run_number: 753, conclusion: "failure", head_branch: "main" }))
    const secondMainBall = ballsFor(OWNER)
    expect(secondMainBall).toHaveLength(1)
    expect(secondMainBall[0]?.message_id).not.toBe(firstMainBall[0]?.message_id)
    const repeatRow = db
      .query("SELECT content, wakes_owner FROM messages WHERE id = ?")
      .get(secondMainBall[0]?.message_id ?? "") as { content: string; wakes_owner: number }
    expect(repeatRow.content).toContain("#753 FAILED on main")
    expect(repeatRow.wakes_owner).toBe(0)

    // 3. Release tag failure opens a separate incident github:beorn/yrd/ci@cli-process-v0.1.0:failing.
    router.handleRun(
      "beorn/yrd",
      makeRun({ name: "ci", run_number: 754, conclusion: "failure", head_branch: "cli-process-v0.1.0" }),
    )
    expect(openIncidents()).toEqual([
      { subject: "beorn/yrd/ci@cli-process-v0.1.0", recipient: OWNER },
      { subject: "beorn/yrd/ci@main", recipient: OWNER },
    ])

    // 4. Reload router (zero process-local state; listOpenIncidents is the only state).
    const reloaded = createWorkflowIncidentRouter(api, { incidentOwner: OWNER })

    // 5. Tag success clears ONLY the tag incident and leaves main open.
    reloaded.handleRun(
      "beorn/yrd",
      makeRun({ name: "ci", run_number: 755, conclusion: "success", head_branch: "cli-process-v0.1.0" }),
    )
    expect(openIncidents()).toEqual([{ subject: "beorn/yrd/ci@main", recipient: OWNER }])
    expect(ballsFor(OWNER).map((b) => b.request_id)).toEqual(["github:beorn/yrd/ci@main:failing"])

    // 6. An ordinary green run on a branch/tag with no open incident sends nothing.
    const countBeforeGreen = (db.query("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n
    reloaded.handleRun(
      "beorn/yrd",
      makeRun({ name: "ci", run_number: 756, conclusion: "success", head_branch: "v1.2.3" }),
    )
    const countAfterGreen = (db.query("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n
    expect(countAfterGreen).toBe(countBeforeGreen)
    expect(broadcasts).toEqual([])

    // 7. main's next success clears main.
    reloaded.handleRun(
      "beorn/yrd",
      makeRun({ name: "ci", run_number: 757, conclusion: "success", head_branch: "main" }),
    )
    expect(openIncidents()).toEqual([])
    expect(ballsFor(OWNER)).toEqual([])
  })

  test("rerun through the poller seam: same html_url failing on attempt 1 then passing on attempt 2 clears the incident", () => {
    const { api } = daemonApi()
    const router = createWorkflowIncidentRouter(api, { incidentOwner: OWNER })
    const nowMs = Date.parse("2026-10-18T22:02:00Z")
    const sharedUrl = "https://github.com/beorn/terminfo.dev/actions/runs/39173749850"

    // Poll 1: attempt 1 fails -> opens incident.
    router.handleRuns(
      "beorn/terminfo.dev",
      [
        makeRun({
          name: "Content Validation",
          run_number: 400,
          run_attempt: 1,
          conclusion: "failure",
          head_branch: "main",
          html_url: sharedUrl,
          updated_at: "2026-10-18T22:01:00Z",
        }),
      ],
      nowMs,
    )
    expect(openIncidents()).toEqual([{ subject: "beorn/terminfo.dev/Content Validation@main", recipient: OWNER }])
    const countAfterAttempt1 = (db.query("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n

    // Same attempt 1 polled again is deduped.
    router.handleRuns(
      "beorn/terminfo.dev",
      [
        makeRun({
          name: "Content Validation",
          run_number: 400,
          run_attempt: 1,
          conclusion: "failure",
          head_branch: "main",
          html_url: sharedUrl,
          updated_at: "2026-10-18T22:01:00Z",
        }),
      ],
      nowMs,
    )
    expect((db.query("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n).toBe(countAfterAttempt1)

    // Poll 2: rerun of the SAME html_url with run_attempt: 2 succeeds -> reaches router and clears incident.
    router.handleRuns(
      "beorn/terminfo.dev",
      [
        makeRun({
          name: "Content Validation",
          run_number: 400,
          run_attempt: 2,
          conclusion: "success",
          head_branch: "main",
          html_url: sharedUrl,
          updated_at: "2026-10-18T22:01:30Z",
        }),
      ],
      nowMs,
    )
    expect(openIncidents()).toEqual([])
    expect(ballsFor(OWNER)).toEqual([])
  })

  // @failure A failing main CI run reached only the incident owner, so @chief learned of a red main only by asking
  // (operator 2026-10-29 16:41, #31806). The owner keeps the one ball; each watcher gets a push copy when the incident
  // opens and when it clears, never a ball and never a copy per repeat failure.
  test("incident watchers: @chief gets a push copy, no ball, when a main incident opens and when it clears", () => {
    const { api } = daemonApi()
    const router = createWorkflowIncidentRouter(api, { incidentOwner: OWNER, incidentWatchers: ["@chief"] })
    const toChief = () =>
      db.query("SELECT content, delivery FROM messages WHERE recipient = ? ORDER BY rowid").all("@chief") as Array<{
        content: string
        delivery: string
      }>

    router.handleRun("beorn/yrd", makeRun({ name: "ci", run_number: 960, conclusion: "failure", head_branch: "main" }))
    router.handleRun("beorn/yrd", makeRun({ name: "ci", run_number: 961, conclusion: "failure", head_branch: "main" }))
    expect(ballsFor(OWNER).map((b) => b.request_id)).toEqual(["github:beorn/yrd/ci@main:failing"])
    expect(ballsFor("@chief")).toEqual([])
    expect(toChief()).toEqual([{ content: expect.stringContaining("#960 FAILED on main"), delivery: "push" }])

    router.handleRun("beorn/yrd", makeRun({ name: "ci", run_number: 962, conclusion: "success", head_branch: "main" }))
    expect(openIncidents()).toEqual([])
    expect(toChief().map((m) => m.content)).toEqual([
      expect.stringContaining("#960 FAILED on main"),
      expect.stringContaining("#962 PASSED on main"),
    ])

    // a task-branch failure is no incident, so the watcher gets nothing
    router.handleRun(
      "beorn/yrd",
      makeRun({ name: "ci", run_number: 963, conclusion: "failure", head_branch: "task/x" }),
    )
    expect(toChief()).toHaveLength(2)
    expect(resolveWorkflowIncidentWatchers({ GITHUB_WORKFLOW_INCIDENT_WATCHERS: " @chief , ,@cto " })).toEqual([
      "@chief",
      "@cto",
    ])
    expect(resolveWorkflowIncidentWatchers({})).toEqual([])
    expect(formatGitHubPluginStartLine(["workflow_run"], "failure", "@dev/fixer", ["@chief"])).toBe(
      "event types: workflow_run, workflow notify: failure, workflow incident owner: @dev/fixer, also told: @chief",
    )
  })

  test("named failing set: failure, timed_out, and startup_failure raise; cancelled, skipped, neutral, action_required, and stale change no incident", () => {
    const { api } = daemonApi()
    const router = createWorkflowIncidentRouter(api, { incidentOwner: OWNER })

    // timed_out on main raises an incident.
    router.handleRun(
      "beorn/yrd",
      makeRun({ name: "ci", run_number: 800, conclusion: "timed_out", head_branch: "main" }),
    )
    expect(openIncidents()).toEqual([{ subject: "beorn/yrd/ci@main", recipient: OWNER }])

    // Non-raising, non-clearing conclusions neither clear the open incident nor open a new one.
    for (const [idx, conclusion] of ["cancelled", "skipped", "neutral", "action_required", "stale"].entries()) {
      router.handleRun("beorn/yrd", makeRun({ name: "ci", run_number: 801 + idx, conclusion, head_branch: "main" }))
      router.handleRun("beorn/yrd", makeRun({ name: "lint", run_number: 810 + idx, conclusion, head_branch: "main" }))
    }
    expect(openIncidents()).toEqual([{ subject: "beorn/yrd/ci@main", recipient: OWNER }])

    // startup_failure on a release tag also raises.
    router.handleRun(
      "beorn/yrd",
      makeRun({ name: "release", run_number: 820, conclusion: "startup_failure", head_branch: "v1.0.0" }),
    )
    expect(openIncidents()).toEqual([
      { subject: "beorn/yrd/ci@main", recipient: OWNER },
      { subject: "beorn/yrd/release@v1.0.0", recipient: OWNER },
    ])
  })

  test("unset-owner config: start log line says incident routing is off and router opens no incident when owner is unset", () => {
    expect(resolveWorkflowIncidentOwner({})).toBeUndefined()
    expect(resolveWorkflowIncidentOwner({ GITHUB_WORKFLOW_INCIDENT_OWNER: "   " })).toBeUndefined()
    expect(resolveWorkflowIncidentOwner({ GITHUB_WORKFLOW_INCIDENT_OWNER: "@dev/fixer" })).toBe("@dev/fixer")

    expect(formatGitHubPluginStartLine(["push", "workflow_run"], "failure", undefined)).toBe(
      "event types: push, workflow_run, workflow notify: failure, workflow incident routing: off (GITHUB_WORKFLOW_INCIDENT_OWNER unset)",
    )
    expect(formatGitHubPluginStartLine(["push", "workflow_run"], "failure", "@dev/fixer")).toBe(
      "event types: push, workflow_run, workflow notify: failure, workflow incident owner: @dev/fixer",
    )

    const { api, broadcasts } = daemonApi()
    const router = createWorkflowIncidentRouter(api, { incidentOwner: undefined })
    router.handleRun("beorn/yrd", makeRun({ name: "ci", run_number: 900, conclusion: "failure", head_branch: "main" }))
    expect(openIncidents()).toEqual([])
    expect(broadcasts).toHaveLength(1)
    expect(broadcasts[0]?.classification).toEqual({
      delivery: "pull",
      topic: "github:workflow:failure",
    })
  })

  test("task-branch failures stay pull broadcasts to * and open no incident ball", () => {
    const { api, broadcasts } = daemonApi()
    const router = createWorkflowIncidentRouter(api, { incidentOwner: OWNER })

    router.handleRun(
      "beorn/terminfo.dev",
      makeRun({
        name: "macos-measurement",
        run_number: 84,
        conclusion: "failure",
        head_branch: "task/29629-freeze-c24025ea22fc",
        html_url: "https://github.com/beorn/terminfo.dev/actions/runs/39171870174",
      }),
    )

    expect(openIncidents()).toEqual([])
    expect(ballsFor(OWNER)).toEqual([])
    expect(broadcasts).toEqual([
      {
        content:
          "[workflow] beorn/terminfo.dev: ✗ macos-measurement #84 FAILED on task/29629-freeze-c24025ea22fc (beorn) https://github.com/beorn/terminfo.dev/actions/runs/39171870174",
        type: "github:workflow",
        classification: {
          delivery: "pull",
          topic: "github:workflow:failure",
        },
      },
    ])
  })
})
