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
import { describe, expect, test } from "vitest"
import {
  createPollHealth,
  detectRateLimit,
  formatEvent,
  gitHubTokenSourceLabel,
  rateLimitInfoOf,
  selectNewEvents,
  summarizePollErrors,
  type GitHubEvent,
  type PollError,
  type RateLimitInfo,
} from "./github-plugin.ts"

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
