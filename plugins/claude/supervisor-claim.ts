/**
 * #27459 gap-5 - one supervisor per launch.
 *
 * A host can spawn a NEW MCP supervisor without closing the old stdio pipe
 * (measured: one codex process held four adapter pairs across two days). The old
 * adapter never sees EOF, so the old supervisor+adapter pair lingers. The
 * launch's own state directory already scopes exactly one launch, so a claim
 * file there lets the newest supervisor take ownership: every supervisor writes
 * its own token at start and, on a short poll, yields when the claim names a
 * DIFFERENT token - the newer start.
 *
 * The claim is a HINT, never a lock. A missing or unreadable file (no state
 * directory, a standalone install) means no takeover; the poll never throws and
 * the launcher's own kill still ends a supervisor normally.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { isAbsolute, join } from "node:path"
import { AG_HOST_SESSION_STATE_DIR_ENV } from "tribe-wire/lib/ag-host-env"

/** Explicit claim directory (wins over the launch state dir); for tests and probes. */
export const TRIBE_PLUGIN_SUPERVISOR_CLAIM_DIR_ENV = "TRIBE_PLUGIN_SUPERVISOR_CLAIM_DIR"
/** Poll interval override; a shorter value makes a takeover observable quickly. */
export const TRIBE_PLUGIN_SUPERVISOR_CLAIM_POLL_MS_ENV = "TRIBE_PLUGIN_SUPERVISOR_CLAIM_POLL_MS"
export const PLUGIN_SUPERVISOR_CLAIM_FILE = "tribe-plugin-supervisor.json"
export const DEFAULT_SUPERVISOR_CLAIM_POLL_MS = 5_000

export type SupervisorClaim = { token: string; pid: number; atMs: number }

/**
 * The claim file for this launch, or null when neither an override nor an
 * absolute launch state directory is known. Deliberately no fallback: a claim
 * outside the launch would let unrelated launches reap each other.
 */
export function resolveSupervisorClaimPath(env: Readonly<NodeJS.ProcessEnv>): string | null {
  const override = env[TRIBE_PLUGIN_SUPERVISOR_CLAIM_DIR_ENV]?.trim()
  if (override) return isAbsolute(override) ? join(override, PLUGIN_SUPERVISOR_CLAIM_FILE) : null
  const stateDir = env[AG_HOST_SESSION_STATE_DIR_ENV]?.trim()
  if (!stateDir || !isAbsolute(stateDir)) return null
  return join(stateDir, PLUGIN_SUPERVISOR_CLAIM_FILE)
}

export function resolveSupervisorClaimPollMs(env: Readonly<NodeJS.ProcessEnv>): number {
  const raw = Number(env[TRIBE_PLUGIN_SUPERVISOR_CLAIM_POLL_MS_ENV]?.trim())
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_SUPERVISOR_CLAIM_POLL_MS
}

/** A claim we cannot read back is `null` (no takeover), never a fabricated owner. */
export function readSupervisorClaim(path: string): SupervisorClaim | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<SupervisorClaim>
    if (typeof parsed?.token !== "string" || parsed.token.length === 0) return null
    return {
      token: parsed.token,
      pid: typeof parsed.pid === "number" ? parsed.pid : -1,
      atMs: typeof parsed.atMs === "number" ? parsed.atMs : 0,
    }
  } catch {
    // silent-fallback-allow: an unreadable claim means NO takeover. The safe
    // direction is to leave a live supervisor alone, never to reap one we cannot
    // identify; the caller still names a write failure on its own stderr.
    return null
  }
}

/**
 * Atomic single-file write (temp + rename) so a reader never sees a torn claim.
 * The parent directory is deliberately NOT created: the launch state dir is the
 * host's, and inventing it would change the host's own exit-record behaviour
 * (plugins/claude daemon-restart, "a launch state directory that does not
 * exist"). A missing directory throws; the caller logs and takes no takeover.
 */
export function writeSupervisorClaim(path: string, claim: SupervisorClaim): void {
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(claim), "utf8")
  renameSync(tmp, path)
}

export function newSupervisorToken(): string {
  return randomUUID()
}

/**
 * True when the claim names a supervisor that is NOT this one. Callers write
 * their own token before watching, so any differing token is a LATER writer.
 */
export function claimSuperseded(mine: string, other: SupervisorClaim | null): boolean {
  return other !== null && other.token !== mine
}

export type SupervisorClaimWatch = {
  /** Stop polling. Safe to call more than once. */
  stop(): void
  /** Read the claim once and fire `onSuperseded` if it changed (tests, probes). */
  checkNow(): void
}

/**
 * Poll the claim and call `onSuperseded` at most once. The interval is unref'd
 * so it can never keep a supervisor alive by itself.
 */
export function startSupervisorClaimWatch(input: {
  path: string
  token: string
  onSuperseded: () => void
  pollMs?: number
  read?: (path: string) => SupervisorClaim | null
}): SupervisorClaimWatch {
  const read = input.read ?? readSupervisorClaim
  const pollMs = input.pollMs ?? DEFAULT_SUPERVISOR_CLAIM_POLL_MS
  let fired = false
  const checkNow = (): void => {
    if (fired) return
    if (!claimSuperseded(input.token, read(input.path))) return
    fired = true
    input.onSuperseded()
  }
  const handle = setInterval(checkNow, pollMs)
  handle.unref?.()
  return {
    stop: () => clearInterval(handle),
    checkNow,
  }
}
