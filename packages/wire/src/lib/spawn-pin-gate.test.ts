/**
 * @ag/tribe/21052 — stale-pin daemon auto-spawn gate.
 *
 * Pins the class observed live during the 2026-07-10 d463c5b rollout: the old
 * daemon was terminated for a controlled replacement and an adapter's
 * connect-failure fallback auto-spawned a daemon from its own STALE tree,
 * winning the socket and silently resurrecting the retired pin. The gate must
 * refuse a spawn whose source is provably older than the last pin that bound
 * the socket, while never bricking standalone/no-git deploys (loud-but-open on
 * indeterminate evidence) or dev forks (diverged allows loudly).
 */
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import {
  evaluateSpawnSource,
  evaluateSpawnSourceForScript,
  pinSidecarPath,
  readPinSidecar,
  writePinSidecar,
} from "./spawn-pin-gate.ts"

describe("evaluateSpawnSource — pure decision table", () => {
  const A = "a".repeat(40)
  const B = "b".repeat(40)

  test("no sidecar evidence — first bind, allow silently", () => {
    const d = evaluateSpawnSource({
      sourcePin: A,
      lastBoundPin: null,
      lastPinKnownToSource: null,
      sourceIsAncestorOfLast: null,
    })
    expect(d).toEqual({ allow: true, reason: null })
  })

  test("equal pins — normal restart, allow silently", () => {
    const d = evaluateSpawnSource({
      sourcePin: A,
      lastBoundPin: A,
      lastPinKnownToSource: null,
      sourceIsAncestorOfLast: null,
    })
    expect(d).toEqual({ allow: true, reason: null })
  })

  test("source has no git pin — cannot prove, allow LOUDLY", () => {
    const d = evaluateSpawnSource({
      sourcePin: null,
      lastBoundPin: B,
      lastPinKnownToSource: null,
      sourceIsAncestorOfLast: null,
    })
    expect(d.allow).toBe(true)
    expect(d.reason).toMatch(/cannot prove/)
  })

  test("last-bound pin unknown to the source tree — provably not a descendant, REFUSE", () => {
    const d = evaluateSpawnSource({
      sourcePin: A,
      lastBoundPin: B,
      lastPinKnownToSource: false,
      sourceIsAncestorOfLast: null,
    })
    expect(d.allow).toBe(false)
    expect(d.reason).toMatch(/does not contain last-bound pin/)
  })

  test("source is an ancestor of last-bound — the observed downgrade, REFUSE", () => {
    const d = evaluateSpawnSource({
      sourcePin: A,
      lastBoundPin: B,
      lastPinKnownToSource: true,
      sourceIsAncestorOfLast: true,
    })
    expect(d.allow).toBe(false)
    expect(d.reason).toMatch(/ancestor of last-bound pin/)
  })

  test("diverged trees — dev fork, allow LOUDLY", () => {
    const d = evaluateSpawnSource({
      sourcePin: A,
      lastBoundPin: B,
      lastPinKnownToSource: true,
      sourceIsAncestorOfLast: false,
    })
    expect(d.allow).toBe(true)
    expect(d.reason).toMatch(/diverges/)
  })
})

describe("pin sidecar round-trip", () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "tribe-pin-sidecar-"))
  })
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("write + read round-trips pin/pid; missing and corrupt sidecars read null", () => {
    const sock = join(dir, "tribe.sock")
    expect(readPinSidecar(sock)).toBeNull()
    writePinSidecar(sock, "c".repeat(40), 4242)
    const rec = readPinSidecar(sock)
    expect(rec?.pin).toBe("c".repeat(40))
    expect(rec?.pid).toBe(4242)
    writeFileSync(pinSidecarPath(sock), "not json at all")
    expect(readPinSidecar(sock)).toBeNull()
  })

  test("writePinSidecar with a null pin leaves prior evidence in place", () => {
    const sock = join(dir, "tribe2.sock")
    writePinSidecar(sock, "d".repeat(40), 1)
    writePinSidecar(sock, null, 2)
    expect(readPinSidecar(sock)?.pin).toBe("d".repeat(40))
  })
})

describe("evaluateSpawnSourceForScript — the observed race, against real git trees", () => {
  // A ── B: the "current" tree is at B; the "stale" tree is a clone at A that
  // has never fetched B (a descendant always contains its ancestors, so the
  // stale tree provably cannot be a descendant of B).
  let root: string
  let currentTree: string
  let staleTree: string
  let pinA = ""
  let pinB = ""

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      encoding: "utf8",
    }).trim()

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "tribe-spawn-gate-"))
    currentTree = join(root, "current")
    staleTree = join(root, "stale")
    execFileSync("git", ["init", "-q", currentTree])
    writeFileSync(join(currentTree, "daemon.ts"), "// v1\n")
    git(currentTree, "add", "-A")
    git(currentTree, "commit", "-q", "-m", "A")
    pinA = git(currentTree, "rev-parse", "HEAD")
    execFileSync("git", ["clone", "-q", currentTree, staleTree])
    writeFileSync(join(currentTree, "daemon.ts"), "// v2\n")
    git(currentTree, "add", "-A")
    git(currentTree, "commit", "-q", "-m", "B")
    pinB = git(currentTree, "rev-parse", "HEAD")
  })
  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test("stale adapter refuses; current adapter proceeds (the competing-spawn race)", () => {
    const sock = join(root, "tribe.sock")
    // The replacement daemon at pin B bound once and recorded itself.
    writePinSidecar(sock, pinB, 1111)

    const stale = evaluateSpawnSourceForScript(join(staleTree, "daemon.ts"), sock)
    expect(stale.allow).toBe(false)
    expect(stale.reason).toMatch(/21052/)

    const current = evaluateSpawnSourceForScript(join(currentTree, "daemon.ts"), sock)
    expect(current).toEqual({ allow: true, reason: null })
  })

  test("stale tree that HAS fetched the newer pin is still refused (proven ancestor)", () => {
    const sock = join(root, "tribe-fetched.sock")
    writePinSidecar(sock, pinB, 2222)
    git(staleTree, "fetch", "-q", "origin")
    const stale = evaluateSpawnSourceForScript(join(staleTree, "daemon.ts"), sock)
    expect(stale.allow).toBe(false)
    expect(stale.reason).toMatch(/ancestor of last-bound pin/)
  })

  test("no sidecar — first start allows silently; equal restart allows silently", () => {
    const freshSock = join(root, "fresh.sock")
    expect(evaluateSpawnSourceForScript(join(staleTree, "daemon.ts"), freshSock)).toEqual({
      allow: true,
      reason: null,
    })
    const restartSock = join(root, "restart.sock")
    writePinSidecar(restartSock, pinA, 3333)
    expect(evaluateSpawnSourceForScript(join(staleTree, "daemon.ts"), restartSock)).toEqual({
      allow: true,
      reason: null,
    })
  })
})
