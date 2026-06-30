/**
 * @failure A GitHub MONITOR-rail 401 ("Bad credentials") is bucketed as a
 *   generic "HTTP 401" with no actionable guidance, so a daemon-side monitor
 *   credential problem is indistinguishable from a transient network/integration
 *   blip — @ci and sitrep mis-read it as an integration failure (km 20593).
 * @level L2 — classification + actionable diagnostic on the warn line.
 * @consumer summarizePollErrors / gitHubTokenSourceLabel in github-plugin.ts
 */
import { describe, expect, test } from "vitest"
import { gitHubTokenSourceLabel, summarizePollErrors, type PollError } from "./github-plugin.ts"

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
