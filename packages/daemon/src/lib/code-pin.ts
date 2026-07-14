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

import { execFileSync } from "node:child_process"
import { relative } from "node:path"
import { createLogger } from "loggily"

const log = createLogger("tribe:code-pin")

/** Source identity belongs to the probed checkout, never to a caller-selected git context. */
function gitProbeEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")))
}

export interface CodePinEval {
  /** True when the running process is provably not the on-disk / pinned code. */
  stale: boolean
  /** Operator-facing remedy, or null when fresh / indeterminate. */
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
 * reproducible in a unit test. A null SHA means "cannot tell" and never reports
 * stale (avoids false alarms in standalone/no-git deploys); the nulls are still
 * surfaced in CodePinStatus so the indeterminate state stays visible.
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
  return { stale: false, reason: null }
}

/**
 * `git -C dir <args>` → trimmed stdout, or null on any failure (git absent, not
 * a repo, ref missing). Null is surfaced in `code_pin` (fail-loud at the report
 * layer) and treated as "cannot tell" by evaluateCodePin — never masked as fresh.
 */
function git(dir: string, args: string[]): string | null {
  try {
    const out = execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      env: gitProbeEnv(),
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
    return out.length > 0 ? out : null
  } catch (err) {
    // Optional external probe: standalone deploys may have no git / no
    // superproject. Log at debug so the miss is observable; the null result
    // surfaces in code_pin rather than being silently dropped.
    log.debug?.(`git ${args.join(" ")} in ${dir} failed: ${String(err)}`)
    return null
  }
}

/**
 * The source commit THIS process loaded — captured at import time, which is
 * process start (and re-capture on the hot-reload re-exec). `import.meta.dir` is
 * inside the tribe checkout, so `git -C` resolves the checkout HEAD.
 */
export const STARTUP_SHA: string | null = git(import.meta.dir, ["rev-parse", "HEAD"])

/** Gather running / on-disk / superproject-pin SHAs and evaluate staleness. */
export function gatherCodePin(
  srcDir: string = import.meta.dir,
  startupSha: string | null = STARTUP_SHA,
): CodePinStatus {
  const onDisk = git(srcDir, ["rev-parse", "HEAD"])
  const superproject = git(srcDir, ["rev-parse", "--show-superproject-working-tree"])
  let superprojectPin: string | null = null
  if (superproject) {
    const top = git(srcDir, ["rev-parse", "--show-toplevel"])
    if (top) {
      const rel = relative(superproject, top)
      superprojectPin = rel.length > 0 ? git(superproject, ["rev-parse", `HEAD:${rel}`]) : null
    }
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
