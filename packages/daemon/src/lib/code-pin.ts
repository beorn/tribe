/**
 * @km/tribe/20033 — stale daemon code detector.
 *
 * The 2026-06-16 stale-metadata regression (@km/tribe/20032) was NOT missing
 * code: live daemon processes started before the tribe fixes were integrated
 * kept serving the old in-memory handlers — bun loads source at process start
 * and has no hot-reload — from a checkout whose submodule pin had not been
 * advanced. Nothing was loud about it. This module makes "the running daemon's
 * code is older than what is on disk / what the superproject pins" a fail-loud,
 * observable condition.
 *
 *   - running  — the source commit THIS process loaded, captured once at module
 *                import (= process start; re-captured on hot-reload re-exec).
 *   - on-disk  — the source commit checked out NOW.
 *   - superproject pin — the commit the hosting superproject pins the tribe
 *                submodule to at its HEAD (null when standalone / no git).
 *
 * running != on-disk → the checkout advanced after the daemon started → restart.
 * on-disk != pin     → the submodule was never updated to its pin → update+restart.
 *
 * Surfaced in `tribe.health()` (`code_pin`) and logged loudly at daemon startup.
 * Vendor-independent: self-locates via `import.meta.dir`, degrades to a visible
 * null (never a false "fresh") when git or a superproject is absent.
 */

import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createLogger } from "loggily"
import { probeGitValue, resolveCheckoutCodeIdentity } from "tribe-wire/lib/code-identity"

const log = createLogger("tribe:code-pin")

export interface CodePinEval {
  /** True when stale, false when fresh, or null when identity is unresolved. */
  stale: boolean | null
  /** Operator-facing remedy, or null when fresh. */
  reason: string | null
}

export interface CodePinStatus extends CodePinEval {
  running: string | null
  on_disk: string | null
  superproject_pin: string | null
  src_dir: string
}

const shortSha = (sha: string): string => sha.slice(0, 12)

/**
 * Pure staleness decision — no IO, so the stale-code class is deterministically
 * reproducible in a unit test. A null SHA means "cannot tell": after checking
 * every provable mismatch, return UNKNOWN rather than certifying freshness.
 * The nulls are still surfaced in CodePinStatus so the indeterminate state
 * stays visible to doctor callers.
 */
export function evaluateCodePin(input: {
  running: string | null
  onDisk: string | null
  superprojectPin: string | null
}): CodePinEval {
  const { running, onDisk, superprojectPin } = input
  if (running && onDisk && running !== onDisk) {
    return {
      stale: true,
      reason:
        `tribe daemon is running code ${shortSha(running)} but the checkout is now ${shortSha(onDisk)} — ` +
        "restart the daemon to load the integrated code",
    }
  }
  if (onDisk && superprojectPin && onDisk !== superprojectPin) {
    return {
      stale: true,
      reason:
        `tribe submodule checkout ${shortSha(onDisk)} != superproject pin ${shortSha(superprojectPin)} — ` +
        "run `git submodule update --init` for the tribe path, then restart the daemon",
    }
  }
  const unresolved = [
    running === null ? "running" : null,
    onDisk === null ? "on_disk" : null,
    superprojectPin === null ? "superproject_pin" : null,
  ].filter((field): field is string => field !== null)
  if (unresolved.length > 0) {
    return {
      stale: null,
      reason: `cannot compare daemon code identity: unresolved ${unresolved.join(", ")}`,
    }
  }
  return { stale: false, reason: null }
}

/**
 * `git -C dir <args>` → trimmed stdout, or null on any failure (git absent, not
 * a repo, ref missing). Null is surfaced in `code_pin` (fail-loud at the report
 * layer) and treated as "cannot tell" by evaluateCodePin — never masked as fresh.
 */
/**
 * The source commit THIS process loaded — captured at import time, which is
 * process start (and re-capture on the hot-reload re-exec). `import.meta.dir` is
 * inside the tribe checkout, so `git -C` resolves the checkout HEAD.
 */
export const TRIBE_SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..")
const startupProbe = probeGitValue(TRIBE_SOURCE_ROOT, ["rev-parse", "HEAD"])
export const STARTUP_SHA: string | null = startupProbe.ok ? startupProbe.value : null

/** Gather running / on-disk / superproject-pin SHAs and evaluate staleness. */
export function gatherCodePin(
  srcDir: string = TRIBE_SOURCE_ROOT,
  startupSha: string | null = STARTUP_SHA,
): CodePinStatus {
  const resolved = resolveCheckoutCodeIdentity(srcDir)
  const onDisk = resolved.onDisk.ok ? resolved.onDisk.value : null
  const superprojectPin = resolved.superprojectPin.ok ? resolved.superprojectPin.value : null
  if (!resolved.onDisk.ok) log.debug?.(`on-disk code probe failed: ${resolved.onDisk.failure.message}`)
  if (!resolved.superprojectPin.ok) {
    log.debug?.(`superproject pin probe failed: ${resolved.superprojectPin.failure.message}`)
  }
  const evaluated = evaluateCodePin({ running: startupSha, onDisk, superprojectPin })
  return {
    ...evaluated,
    running: startupSha,
    on_disk: onDisk,
    superproject_pin: superprojectPin,
    src_dir: srcDir,
  }
}
