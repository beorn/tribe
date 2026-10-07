/**
 * `.beads/` discovery — the only home of `removely` in the wire config surface.
 *
 * 27941: kept apart from `config-light` because the adapter child calls
 * `resolveProjectName()` at startup (making this graph unavoidable for it), while the
 * supervisor calls neither function. The split is what lets the supervisor stop paying
 * removely's ~2.1 MB, and it keeps the import out of `db-path`'s flock path.
 */

import { existsSync, readFileSync } from "node:fs"
import { basename, dirname, parse, resolve } from "node:path"
import { findAncestorWithin, findGitProjectRoot } from "removely"

/**
 * Walk up from `path` to the nearest ancestor that exists on disk. `git -C`
 * (what `findGitProjectRoot` shells out to) needs a real directory to chdir
 * into — Node's `spawnSync` reports that as `result.error` before git ever
 * runs, and `findGitProjectRoot` turns any such error into a throw by design
 * (removely's own contract: "execution and repository errors throw"). A
 * caller here may legitimately probe a *prospective* path — e.g. `findBeadsDir`
 * discovering config for a directory that hasn't been created yet — so the
 * git probe itself must run against real ground. Every absolute path's chain
 * of ancestors terminates at the filesystem root, which always exists.
 */
function nearestExistingAncestor(path: string): string {
  let candidate = path
  while (!existsSync(candidate)) {
    const parent = dirname(candidate)
    if (parent === candidate) return candidate // filesystem root
    candidate = parent
  }
  return candidate
}

/** Find .beads/ inside the current Git/superproject boundary. */
export function findBeadsDir(from?: string): string | null {
  const start = resolve(from ?? process.cwd())
  const boundary = findGitProjectRoot(nearestExistingAncestor(start)) ?? parse(start).root
  const projectRoot = findAncestorWithin(start, boundary, (directory) => existsSync(resolve(directory, ".beads")))
  return projectRoot ? resolve(projectRoot, ".beads") : null
}

/** Resolve project name from .beads/ config or directory name.
 *  Returns a short lowercase slug (e.g. "km", "decker") for namespacing sessions. */
export function resolveProjectName(cwd?: string): string {
  const dir = cwd ?? process.cwd()
  const beadsDir = findBeadsDir(dir)
  if (beadsDir) {
    const projectRoot = dirname(beadsDir)
    const configPath = resolve(beadsDir, "config.yaml")
    if (existsSync(configPath)) {
      try {
        const content = readFileSync(configPath, "utf-8")
        const match = content.match(/^project:\s*["']?(\w+)["']?/m)
        if (match?.[1]) return match[1].toLowerCase()
      } catch (error) {
        if (!(error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error
      }
    }
    return basename(projectRoot).toLowerCase()
  }
  // No nearby .beads/ — use cwd directory name
  return basename(dir).toLowerCase()
}
