/**
 * Vendor-local runtime identity — `<version>+<sha>`, so an operator can tell which
 * code a tribe process is running (the same #undead-adjacent check `code-pin`
 * makes for the daemon, surfaced for the per-invocation CLI + daemon startup).
 *
 * Standalone-safe by construction: node builtins only, NO product workspace
 * deps (tribe-wire ships independently). A missing git or package.json degrades to
 * a visible `unknown` / `0.0.0`, never a fabricated SHA or version.
 *
 * Bead: @km/infra/20359 — system-wide hot-reload version+sha standardization.
 */

import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/** Dir of this module — ESM-standard `import.meta.url` so it resolves under the
 *  bun runtime AND a Vite/Vitest transform (bun-only `import.meta.dir` is
 *  `undefined` under test). */
function moduleDir(): string {
  return dirname(fileURLToPath(import.meta.url))
}

/** `<version>+<sha>`; sha → `unknown` when git is unavailable (never fabricated). */
export function formatRuntimeId(version: string, sha: string | null): string {
  return `${version}+${sha ?? "unknown"}`
}

/** Short HEAD sha of the checkout this file lives in, or null (git absent / standalone). */
export function gitShortHead(dir: string = moduleDir()): string | null {
  try {
    const out = execFileSync("git", ["-C", dir, "rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
    return out.length > 0 ? out : null
  } catch {
    // Standalone clone / no git: surfaced LOUDLY as `unknown` by formatRuntimeId,
    // never masked as a real commit. (Mirrors code-pin's null-is-visible contract.)
    return null
  }
}

/** This wire package's semver, or `0.0.0` when its package.json is unreadable. */
export function wireVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(moduleDir(), "..", "package.json"), "utf8")) as { version?: unknown }
    return typeof pkg.version === "string" && pkg.version.length > 0 ? pkg.version : "0.0.0"
  } catch {
    // version DISPLAY only — a missing/garbled package.json must not block
    // `--version`; degrade to a placebo semver rather than throw.
    return "0.0.0"
  }
}

/** `tribe-wire`'s running-code id, `<wire-version>+<sha>`. */
export function tribeWireRuntimeId(): string {
  return formatRuntimeId(wireVersion(), gitShortHead())
}
