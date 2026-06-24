/**
 * Reaper-exempt markers — exempt a PID from the health-reaper's auto-kill
 * (@km/infra/reaper-and-cwd-guard-hardening-followons gap 1).
 *
 * Why: a live `#undead` repro is high-CPU by nature, owned by no tribe session,
 * and never "claimed", so the unclaimed-after-60s reaper would kill the very
 * process under investigation (it reaped @agent/7's flicker repro). An operator
 * marks the repro PID exempt (`tribe-wire reaper-exempt <pid>`) and the reaper
 * skips it at suspect-detection.
 *
 * Design: one marker file per exempt PID under a shared XDG dir that BOTH the
 * daemon (reader, `isReaperExempt`) and the CLI (writer) compute identically —
 * the same file-marker shape as the reload sentinel. FAIL-SAFE by construction:
 * a present marker only ever PREVENTS a kill, never causes one. Markers are
 * cleared explicitly (`--clear`) or fall away on a fresh XDG runtime dir.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

/** The dir holding per-PID exempt markers — mirrors {@link resolveSocketPath}'s XDG resolution. */
export function resolveReaperExemptDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_RUNTIME_DIR
  const base = xdg ?? resolve(env.HOME ?? "/tmp", ".local/share/tribe")
  return resolve(base, "reaper-exempt")
}

/** Marker path for one exempt PID. */
export function reaperExemptMarkerPath(pid: number, env: NodeJS.ProcessEnv = process.env): string {
  return resolve(resolveReaperExemptDir(env), String(pid))
}

/** True iff `pid` has an exempt marker — the daemon's reaper checks this before treating a PID as a suspect. */
export function isReaperExempt(pid: number, env: NodeJS.ProcessEnv = process.env): boolean {
  return existsSync(reaperExemptMarkerPath(pid, env))
}

/** Mark `pid` exempt (idempotent). `reason` is stored for `--list` provenance. */
export function setReaperExempt(pid: number, reason = "", env: NodeJS.ProcessEnv = process.env): void {
  mkdirSync(resolveReaperExemptDir(env), { recursive: true })
  writeFileSync(reaperExemptMarkerPath(pid, env), `${reason.trim()}\n`)
}

/** Remove `pid`'s exempt marker. Returns false when there was none (loud caller-side, never silent). */
export function clearReaperExempt(pid: number, env: NodeJS.ProcessEnv = process.env): boolean {
  const path = reaperExemptMarkerPath(pid, env)
  if (!existsSync(path)) return false
  rmSync(path, { force: true })
  return true
}

export interface ReaperExemptEntry {
  pid: number
  reason: string
}

/** All current exemptions (pid + stored reason). Empty when the dir is absent (no markers yet). */
export function listReaperExempt(env: NodeJS.ProcessEnv = process.env): ReaperExemptEntry[] {
  const dir = resolveReaperExemptDir(env)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .map((name) => Number(name))
    .filter((pid) => Number.isInteger(pid) && pid > 0)
    .map((pid) => ({ pid, reason: readFileSync(reaperExemptMarkerPath(pid, env), "utf8").trim() }))
}
