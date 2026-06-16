/**
 * project-root.ts — resolve the HOST repo's project root for hook-config and
 * session-memory lookups.
 *
 * recall is a VENDORED submodule: resolving a project root from the code's own
 * location (`import.meta.dir` walked up N levels) lands on the recall package /
 * `vendor/tribe`, NOT the repo the user is actually in. That made
 * `recall status` inspect `vendor/tribe/.claude/settings.json` (which never
 * exists) and report hook config as "unknown" even in a healthy run
 * (@km/bearly/19221/19990). Resolving from the CALLER's cwd inspects the real
 * host repo instead.
 */

import * as fs from "fs"
import * as path from "path"

/**
 * Walk UP from `cwd` to the host repo's project root — the directory whose
 * `.claude/` holds the hook config. Prefers the nearest ancestor containing a
 * `.claude/` entry (where `settings.json` lives); falls back to the nearest
 * `.git` repo root; else `cwd` itself.
 *
 * Returning `cwd` when there are no project markers (e.g. a bare `/tmp` clean
 * root) is deliberate: `checkHookConfig` then reports `localConfigPresent:false`
 * for that real cwd, keeping the 19988 "no local config at this root" diagnostic
 * correct rather than masking it with a package path.
 *
 * Pure except for `fs.existsSync` probes — unit-testable with a temp tree.
 */
export function resolveHostProjectRoot(cwd: string): string {
  let dir = path.resolve(cwd)
  let gitRoot: string | null = null
  // Bounded walk — deep trees still terminate at the filesystem root.
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(path.join(dir, ".claude"))) return dir
    if (gitRoot === null && fs.existsSync(path.join(dir, ".git"))) gitRoot = dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return gitRoot ?? path.resolve(cwd)
}
