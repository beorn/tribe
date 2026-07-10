/**
 * @ag/tribe/21052 — stale-pin daemon auto-spawn gate.
 *
 * Observed during the 2026-07-10 d463c5b lifecycle rollout: the moment the old
 * daemon was terminated for a controlled replacement, an adapter's
 * connect-failure fallback auto-spawned a daemon FROM ITS OWN (stale) source
 * tree and won the socket — silently resurrecting the pin the operator had
 * just retired. The replacement daemon then found the socket taken and exited
 * politely. Nothing was loud about the downgrade.
 *
 * The mechanism here makes that class fail closed without any new
 * gate/script/manifest:
 *
 *   - The daemon, immediately after BINDING the socket, writes a sidecar file
 *     `<socketPath>.pin` recording the source pin it runs (the existing
 *     code-pin capture). The file intentionally survives the daemon's death —
 *     "the last pin that ever bound this socket" is exactly the reference an
 *     auto-spawner must not downgrade past.
 *   - Every auto-spawn path (adapter `connectOrStart` fallback, and the daemon
 *     boot itself as the second door) evaluates its OWN source pin against the
 *     sidecar before spawning/binding:
 *
 *       equal                      → allow (normal restart of the same code)
 *       no sidecar / unknown pins  → allow, loudly (cannot prove; standalone
 *                                    deploys must not brick — same philosophy
 *                                    as code-pin's "never a false fresh")
 *       sidecar pin NOT an object
 *       in the source tree         → REFUSE (a newer tree always contains its
 *                                    ancestors, so a tree that has never seen
 *                                    the last-bound pin is provably not a
 *                                    descendant of it)
 *       source pin IS an ancestor
 *       of the sidecar pin         → REFUSE (proven downgrade — the observed
 *                                    incident)
 *       diverged (neither contains
 *       the other)                 → allow, loudly (dev forks are legitimate;
 *                                    the class killed here is resurrect-OLDER)
 *
 * The one window this cannot close by construction: the very first upgrade,
 * before the new pin has ever bound (the sidecar still names the old pin, and
 * old == old is a legal restart). That window belongs to the operator's
 * controlled-replace rail (terminate → immediately start from the verified
 * checkout), which is how the d463c5b rollout ultimately succeeded.
 */

import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { createLogger } from "loggily"

const log = createLogger("tribe:spawn-pin-gate")

export interface SpawnSourceDecision {
  allow: boolean
  /** Operator-facing explanation; null only for the silent equal/fresh case. */
  reason: string | null
}

const short = (sha: string): string => sha.slice(0, 12)

/**
 * Pure decision over facts the IO layer gathers. Deterministically unit-tested;
 * no git, no fs.
 */
export function evaluateSpawnSource(input: {
  /** HEAD pin of the tree the daemon script would run from (null = no git). */
  sourcePin: string | null
  /** Pin recorded by the last daemon that bound this socket (null = no sidecar). */
  lastBoundPin: string | null
  /** Is lastBoundPin a known object in the source tree? (null = not checked). */
  lastPinKnownToSource: boolean | null
  /** Is sourcePin an ancestor of lastBoundPin? (null = not provable). */
  sourceIsAncestorOfLast: boolean | null
}): SpawnSourceDecision {
  const { sourcePin, lastBoundPin, lastPinKnownToSource, sourceIsAncestorOfLast } = input
  if (!lastBoundPin) return { allow: true, reason: null } // nothing ever bound — first start
  if (!sourcePin) {
    return {
      allow: true,
      reason: `spawn source has no resolvable git pin; last bound pin is ${short(lastBoundPin)} — cannot prove freshness, allowing loudly`,
    }
  }
  if (sourcePin === lastBoundPin) return { allow: true, reason: null }
  if (lastPinKnownToSource === false) {
    return {
      allow: false,
      reason: `stale spawn source: tree at ${short(sourcePin)} does not contain last-bound pin ${short(lastBoundPin)} — a descendant always contains its ancestors; refusing to resurrect older code (21052)`,
    }
  }
  if (sourceIsAncestorOfLast === true) {
    return {
      allow: false,
      reason: `stale spawn source: ${short(sourcePin)} is an ancestor of last-bound pin ${short(lastBoundPin)} — refusing to resurrect older code (21052)`,
    }
  }
  if (sourceIsAncestorOfLast === false) {
    return {
      allow: true,
      reason: `spawn source ${short(sourcePin)} diverges from last-bound pin ${short(lastBoundPin)} (neither is the other's ancestor) — allowing loudly (dev fork?)`,
    }
  }
  return {
    allow: true,
    reason: `ancestry of spawn source ${short(sourcePin)} vs last-bound pin ${short(lastBoundPin)} is indeterminate — cannot prove staleness, allowing loudly`,
  }
}

/** Sidecar path convention: right next to the socket, survives daemon death. */
export function pinSidecarPath(socketPath: string): string {
  return `${socketPath}.pin`
}

export interface PinSidecar {
  pin: string
  pid: number
  atMs: number
}

/** Best-effort read; a missing or corrupt sidecar is null (first start / legacy). */
export function readPinSidecar(socketPath: string): PinSidecar | null {
  const p = pinSidecarPath(socketPath)
  if (!existsSync(p)) return null
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as Partial<PinSidecar>
    if (typeof parsed.pin === "string" && parsed.pin.length >= 7) {
      return { pin: parsed.pin, pid: Number(parsed.pid ?? 0), atMs: Number(parsed.atMs ?? 0) }
    }
  } catch {
    /* corrupt sidecar = no evidence; the gate stays loud-but-open */
  }
  return null
}

/** Called by the daemon RIGHT AFTER binding the socket. Never throws. */
export function writePinSidecar(socketPath: string, pin: string | null, pid: number = process.pid): void {
  if (!pin) return // no provable pin (standalone/no-git) — leave prior evidence in place
  try {
    writeFileSync(pinSidecarPath(socketPath), JSON.stringify({ pin, pid, atMs: Date.now() }))
  } catch (err) {
    log.warn?.(`could not write pin sidecar for ${socketPath}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function git(cwd: string, args: string[]): { status: number; stdout: string } {
  try {
    const stdout = execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
    return { status: 0, stdout: stdout.trim() }
  } catch (err) {
    const status = (err as { status?: number }).status
    return { status: typeof status === "number" ? status : 1, stdout: "" }
  }
}

/**
 * Gather the decision facts for a daemon script path, then decide. IO wrapper
 * over the pure predicate — call sites log `reason` and either proceed or
 * refuse based on `allow`.
 */
export function evaluateSpawnSourceForScript(daemonScript: string, socketPath: string): SpawnSourceDecision {
  return evaluateSpawnSourceForTree(dirname(daemonScript), socketPath)
}

/** Same gate keyed by a directory inside the source tree (the daemon's own boot door). */
export function evaluateSpawnSourceForTree(tree: string, socketPath: string): SpawnSourceDecision {
  const sidecar = readPinSidecar(socketPath)
  if (!sidecar) return { allow: true, reason: null }
  const head = git(tree, ["rev-parse", "HEAD"])
  const sourcePin = head.status === 0 && head.stdout !== "" ? head.stdout : null
  let lastPinKnownToSource: boolean | null = null
  let sourceIsAncestorOfLast: boolean | null = null
  if (sourcePin && sourcePin !== sidecar.pin) {
    lastPinKnownToSource = git(tree, ["cat-file", "-e", `${sidecar.pin}^{commit}`]).status === 0
    if (lastPinKnownToSource) {
      const anc = git(tree, ["merge-base", "--is-ancestor", sourcePin, sidecar.pin])
      sourceIsAncestorOfLast = anc.status === 0 ? true : anc.status === 1 ? false : null
    }
  }
  return evaluateSpawnSource({ sourcePin, lastBoundPin: sidecar.pin, lastPinKnownToSource, sourceIsAncestorOfLast })
}
