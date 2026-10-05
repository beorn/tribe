/**
 * @failure  A host can spawn a new MCP supervisor without closing the old stdio
 *           pipe, so without a per-launch claim the old supervisor+adapter pair
 *           lingers for days (#27459 gap-5; measured 50 supervisors for 21 seats).
 * @level    l2
 * @consumer @dev/luna6 #27459 gap-5, plugin supervisor lifecycle
 * @testonly none
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { AG_HOST_SESSION_STATE_DIR_ENV } from "tribe-wire/lib/ag-host-env"
import {
  claimSuperseded,
  DEFAULT_SUPERVISOR_CLAIM_POLL_MS,
  newSupervisorToken,
  PLUGIN_SUPERVISOR_CLAIM_FILE,
  readSupervisorClaim,
  resolveSupervisorClaimPath,
  resolveSupervisorClaimPollMs,
  startSupervisorClaimWatch,
  TRIBE_PLUGIN_SUPERVISOR_CLAIM_DIR_ENV,
  TRIBE_PLUGIN_SUPERVISOR_CLAIM_POLL_MS_ENV,
  writeSupervisorClaim,
} from "../supervisor-claim.ts"

function tmpClaimDir(): string {
  return mkdtempSync(join(tmpdir(), "tribe-supervisor-claim-"))
}

describe("supervisor claim path (#27459 gap-5)", () => {
  it("uses the launch state dir by default and refuses a relative one", () => {
    expect(resolveSupervisorClaimPath({ [AG_HOST_SESSION_STATE_DIR_ENV]: "/s" })).toBe(
      join("/s", PLUGIN_SUPERVISOR_CLAIM_FILE),
    )
    expect(resolveSupervisorClaimPath({ [AG_HOST_SESSION_STATE_DIR_ENV]: "relative" })).toBeNull()
    expect(resolveSupervisorClaimPath({})).toBeNull()
  })

  it("prefers an absolute explicit claim dir and refuses a relative one", () => {
    const env = { [TRIBE_PLUGIN_SUPERVISOR_CLAIM_DIR_ENV]: "/claim", [AG_HOST_SESSION_STATE_DIR_ENV]: "/s" }
    expect(resolveSupervisorClaimPath(env)).toBe(join("/claim", PLUGIN_SUPERVISOR_CLAIM_FILE))
    expect(resolveSupervisorClaimPath({ [TRIBE_PLUGIN_SUPERVISOR_CLAIM_DIR_ENV]: "rel" })).toBeNull()
  })

  it("resolves a positive poll interval and falls back otherwise", () => {
    expect(resolveSupervisorClaimPollMs({ [TRIBE_PLUGIN_SUPERVISOR_CLAIM_POLL_MS_ENV]: "25" })).toBe(25)
    expect(resolveSupervisorClaimPollMs({})).toBe(DEFAULT_SUPERVISOR_CLAIM_POLL_MS)
    expect(resolveSupervisorClaimPollMs({ [TRIBE_PLUGIN_SUPERVISOR_CLAIM_POLL_MS_ENV]: "0" })).toBe(
      DEFAULT_SUPERVISOR_CLAIM_POLL_MS,
    )
    expect(resolveSupervisorClaimPollMs({ [TRIBE_PLUGIN_SUPERVISOR_CLAIM_POLL_MS_ENV]: "nope" })).toBe(
      DEFAULT_SUPERVISOR_CLAIM_POLL_MS,
    )
  })
})

describe("supervisor claim read/write (#27459 gap-5)", () => {
  it("round-trips a claim and reads a missing or torn file as null, never a fabricated owner", () => {
    const dir = tmpClaimDir()
    const path = join(dir, PLUGIN_SUPERVISOR_CLAIM_FILE)
    expect(readSupervisorClaim(path)).toBeNull()
    writeSupervisorClaim(path, { token: "t1", pid: 42, atMs: 7 })
    expect(readSupervisorClaim(path)).toEqual({ token: "t1", pid: 42, atMs: 7 })
    writeFileSync(path, "{ not json", "utf8")
    expect(readSupervisorClaim(path)).toBeNull()
    writeFileSync(path, JSON.stringify({ pid: 1 }), "utf8")
    expect(readSupervisorClaim(path)).toBeNull()
    rmSync(dir, { recursive: true, force: true })
  })

  it("names a differing token superseded, and the same or absent token not", () => {
    expect(claimSuperseded("t1", null)).toBe(false)
    expect(claimSuperseded("t1", { token: "t1", pid: 1, atMs: 0 })).toBe(false)
    expect(claimSuperseded("t1", { token: "t2", pid: 2, atMs: 0 })).toBe(true)
  })

  it("mints a unique non-empty token", () => {
    const token = newSupervisorToken()
    expect(token.length).toBeGreaterThan(0)
    expect(token).not.toBe(newSupervisorToken())
  })

  it("never creates the launch state directory, which the host owns", () => {
    const dir = tmpClaimDir()
    const missing = join(dir, "missing-launch-state")
    expect(() =>
      writeSupervisorClaim(join(missing, PLUGIN_SUPERVISOR_CLAIM_FILE), { token: "t", pid: 1, atMs: 0 }),
    ).toThrow()
    expect(existsSync(missing)).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe("supervisor claim watch (#27459 gap-5)", () => {
  it("fires once when a newer supervisor overwrites the claim, never for its own token", () => {
    const dir = tmpClaimDir()
    const path = join(dir, PLUGIN_SUPERVISOR_CLAIM_FILE)
    writeSupervisorClaim(path, { token: "mine", pid: 1, atMs: 0 })
    let fired = 0
    const watch = startSupervisorClaimWatch({
      path,
      token: "mine",
      pollMs: 5,
      onSuperseded: () => {
        fired += 1
      },
    })
    watch.checkNow()
    expect(fired).toBe(0)
    writeSupervisorClaim(path, { token: "newer", pid: 2, atMs: 1 })
    watch.checkNow()
    expect(fired).toBe(1)
    watch.checkNow()
    expect(fired).toBe(1)
    watch.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  it("does not fire when the claim is missing", async () => {
    const dir = tmpClaimDir()
    const path = join(dir, PLUGIN_SUPERVISOR_CLAIM_FILE)
    let fired = 0
    const watch = startSupervisorClaimWatch({
      path,
      token: "mine",
      pollMs: 5,
      onSuperseded: () => {
        fired += 1
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(fired).toBe(0)
    watch.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  it("fires from the real timer, not only an explicit check", async () => {
    const dir = tmpClaimDir()
    const path = join(dir, PLUGIN_SUPERVISOR_CLAIM_FILE)
    writeSupervisorClaim(path, { token: "mine", pid: 1, atMs: 0 })
    await new Promise<void>((resolve) => {
      const watch = startSupervisorClaimWatch({
        path,
        token: "mine",
        pollMs: 5,
        onSuperseded: () => {
          watch.stop()
          resolve()
        },
      })
      writeSupervisorClaim(path, { token: "newer", pid: 2, atMs: 1 })
    })
    rmSync(dir, { recursive: true, force: true })
  })
})
