/** Machine-local, fail-loud persistence for the daemon GitHub poll cursor. */
import { acquireFlockBlocking } from "@bearly/flock"
import { randomUUID } from "node:crypto"
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, resolve } from "node:path"

import { safeRemoveSync } from "removely"

export interface GitHubCursorState {
  readonly repos: Record<string, { readonly lastEventId: string; readonly lastPollAt: string }>
}

export interface GitHubCursorStore {
  readonly path: string
  readonly state: GitHubCursorState
  save(state: GitHubCursorState): void
}

interface OpenGitHubCursorStoreOptions {
  readonly stateDir: string
  readonly legacyPath?: string | null
}

type CursorEnvironment = Readonly<Record<string, string | undefined>>

export function resolveGitHubCursorPath(env: CursorEnvironment = process.env): string {
  const dataHome = env.XDG_DATA_HOME?.trim() || resolve(env.HOME?.trim() || homedir(), ".local/share")
  return resolve(dataHome, "tribe", "github-cursor.json")
}

/** The one place a daemon may be told which project it belongs to. */
export const TRIBE_PROJECT_ROOT_ENV = "TRIBE_PROJECT_ROOT"

/**
 * Locate the legacy project-local cursor to adopt, or null when there is
 * nothing to adopt from.
 *
 * This is deliberately NOT a search. It used to be `findBeadsDir()` with no
 * argument, which resolves from `process.cwd()` and walks up to the enclosing
 * Git boundary — so the daemon adopted whatever `.beads/github-cursor.json`
 * happened to sit above the directory its launcher started it in. Stale copies
 * of the old writer are still scattered across machines and can mint more, so
 * that search could hand the daemon a cursor from an unrelated project.
 *
 * The rule now: adopt only from an explicitly declared root, and look only at
 * that root's own `.beads/`. No ancestor walk, and never `process.cwd()` — a
 * daemon that was not told which project it serves does not guess.
 */
export function resolveLegacyGitHubCursorPath(env: CursorEnvironment = process.env): string | null {
  const declaredRoot = env[TRIBE_PROJECT_ROOT_ENV]?.trim()
  if (!declaredRoot) return null
  return resolve(declaredRoot, ".beads", "github-cursor.json")
}

/**
 * Open the daemon cursor and adopt the legacy project-local carrier exactly
 * once. The migration is convergent: an interrupted copy leaves identical
 * dual state, which the next locked open safely collapses.
 */
export function openGitHubCursorStore(options: OpenGitHubCursorStoreOptions): GitHubCursorStore {
  const path = resolve(options.stateDir, "github-cursor.json")
  const legacyPath =
    options.legacyPath === undefined || options.legacyPath === null ? null : resolve(options.legacyPath)
  const distinctLegacyPath = legacyPath !== null && legacyPath !== path ? legacyPath : null
  try {
    mkdirSync(options.stateDir, { recursive: true })

    let state: GitHubCursorState
    using _migrationLock = acquireFlockBlocking(`${path}.migration.lock`)
    const targetExists = existsSync(path)
    const legacyExists = distinctLegacyPath !== null && existsSync(distinctLegacyPath)

    if (targetExists && legacyExists) {
      const targetState = readCursor(path)
      const legacyState = readCursor(distinctLegacyPath)
      if (!sameCursor(targetState, legacyState)) {
        throw new Error("conflicting GitHub cursor states; refusing to choose, merge, or reset either cursor")
      }
      safeRemoveSync(distinctLegacyPath, { within: dirname(distinctLegacyPath), allowMissing: false })
      state = targetState
    } else if (targetExists) {
      state = readCursor(path)
    } else if (legacyExists) {
      state = readCursor(distinctLegacyPath)
      writeCursorAtomic(path, state)
      const installed = readCursor(path)
      if (!sameCursor(state, installed)) {
        throw new Error("adoption changed state while copying the legacy cursor")
      }
      safeRemoveSync(distinctLegacyPath, { within: dirname(distinctLegacyPath), allowMissing: false })
    } else {
      state = { repos: {} }
    }

    return {
      path,
      state,
      save(next) {
        writeCursorAtomic(path, next)
      },
    }
  } catch (error) {
    throw new Error(
      `GitHub cursor open failed after inspecting XDG destination ${path} and legacy source ` +
        `${distinctLegacyPath ?? "(not configured)"}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function cursorError(path: string, detail: string): Error {
  return new Error(`GitHub cursor ${path} ${detail}`)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Reflect.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function parseGitHubCursorState(bytes: string, path: string): GitHubCursorState {
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes)
  } catch (error) {
    throw cursorError(path, `is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.repos) || Object.keys(parsed).some((key) => key !== "repos")) {
    throw cursorError(path, 'must be an object with exactly one "repos" object')
  }

  const repos: GitHubCursorState["repos"] = {}
  for (const [repo, value] of Object.entries(parsed.repos)) {
    if (repo.length === 0 || !isPlainObject(value)) {
      throw cursorError(path, `has an invalid repo cursor at ${JSON.stringify(repo)}`)
    }
    const keys = Object.keys(value).sort()
    if (
      keys.length !== 2 ||
      keys[0] !== "lastEventId" ||
      keys[1] !== "lastPollAt" ||
      typeof value.lastEventId !== "string" ||
      value.lastEventId.length === 0 ||
      typeof value.lastPollAt !== "string" ||
      value.lastPollAt.length === 0
    ) {
      throw cursorError(path, `repo ${JSON.stringify(repo)} must contain non-empty lastEventId and lastPollAt strings`)
    }
    repos[repo] = { lastEventId: value.lastEventId, lastPollAt: value.lastPollAt }
  }
  return { repos }
}

function canonicalCursorJson(state: GitHubCursorState): string {
  const validated = parseGitHubCursorState(JSON.stringify(state), "<in-memory>")
  return `${JSON.stringify(
    {
      repos: Object.fromEntries(Object.entries(validated.repos).sort(([left], [right]) => left.localeCompare(right))),
    },
    null,
    2,
  )}\n`
}

function readCursor(path: string): GitHubCursorState {
  let bytes: string
  try {
    bytes = readFileSync(path, "utf8")
  } catch (error) {
    throw cursorError(path, `could not be read: ${error instanceof Error ? error.message : String(error)}`)
  }
  return parseGitHubCursorState(bytes, path)
}

function writeCursorAtomic(path: string, state: GitHubCursorState): void {
  const parent = dirname(path)
  mkdirSync(parent, { recursive: true })
  const temporary = resolve(parent, `.${path.slice(path.lastIndexOf("/") + 1)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, canonicalCursorJson(state), { encoding: "utf8", mode: 0o600, flag: "wx" })
    const file = openSync(temporary, "r")
    try {
      fsyncSync(file)
    } finally {
      closeSync(file)
    }
    renameSync(temporary, path)
    const directory = openSync(parent, "r")
    try {
      fsyncSync(directory)
    } finally {
      closeSync(directory)
    }
  } catch (error) {
    safeRemoveSync(temporary, { within: parent, allowMissing: true })
    throw cursorError(
      path,
      `could not be written atomically: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function sameCursor(left: GitHubCursorState, right: GitHubCursorState): boolean {
  return canonicalCursorJson(left) === canonicalCursorJson(right)
}
