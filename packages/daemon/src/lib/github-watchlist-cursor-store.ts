/** Machine-local, fail-loud persistence for the daemon GitHub watchlist item cursors. */
import { atomicWriteFileSync } from "@bearly/durable-file"
import { acquireFlockBlocking } from "@bearly/flock"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, resolve } from "node:path"

export interface WatchedItemCursor {
  readonly state: string
  readonly merged: boolean
  readonly closedAt: string | null
  readonly lastCommentId: number
  readonly lastReviewId: number
  readonly lastReviewCommentId: number
  readonly lastPollAt: string
}

export interface GitHubWatchlistCursorState {
  readonly items: Record<string, WatchedItemCursor>
}

export interface GitHubWatchlistCursorStore {
  readonly path: string
  readonly state: GitHubWatchlistCursorState
  save(state: GitHubWatchlistCursorState): void
}

type CursorEnvironment = Readonly<Record<string, string | undefined>>

export function resolveGitHubWatchlistCursorPath(env: CursorEnvironment = process.env): string {
  const dataHome = env.XDG_DATA_HOME?.trim() || resolve(env.HOME?.trim() || homedir(), ".local/share")
  return resolve(dataHome, "tribe", "github-watchlist-cursor.json")
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Reflect.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function cursorError(path: string, detail: string): Error {
  return new Error(`GitHub watchlist cursor ${path} ${detail}`)
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
}

export function parseGitHubWatchlistCursorState(bytes: string, path: string): GitHubWatchlistCursorState {
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes)
  } catch (error) {
    throw cursorError(path, `is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.items) || Object.keys(parsed).some((key) => key !== "items")) {
    throw cursorError(path, 'must be an object with exactly one "items" object')
  }

  const items: Record<string, WatchedItemCursor> = {}
  for (const [key, value] of Object.entries(parsed.items)) {
    if (key.length === 0 || !isPlainObject(value)) {
      throw cursorError(path, `has an invalid item cursor at ${JSON.stringify(key)}`)
    }
    if (
      typeof value.state !== "string" ||
      value.state.length === 0 ||
      typeof value.merged !== "boolean" ||
      (value.closedAt !== null && typeof value.closedAt !== "string") ||
      !isNonNegativeInt(value.lastCommentId) ||
      !isNonNegativeInt(value.lastReviewId) ||
      !isNonNegativeInt(value.lastReviewCommentId) ||
      typeof value.lastPollAt !== "string" ||
      value.lastPollAt.length === 0
    ) {
      throw cursorError(path, `item ${JSON.stringify(key)} has invalid cursor fields`)
    }
    items[key] = {
      state: value.state,
      merged: value.merged,
      closedAt: value.closedAt,
      lastCommentId: value.lastCommentId,
      lastReviewId: value.lastReviewId,
      lastReviewCommentId: value.lastReviewCommentId,
      lastPollAt: value.lastPollAt,
    }
  }
  return { items }
}

function canonicalCursorJson(state: GitHubWatchlistCursorState): string {
  const validated = parseGitHubWatchlistCursorState(JSON.stringify(state), "<in-memory>")
  return `${JSON.stringify(
    {
      items: Object.fromEntries(Object.entries(validated.items).sort(([left], [right]) => left.localeCompare(right))),
    },
    null,
    2,
  )}\n`
}

function readCursor(path: string): GitHubWatchlistCursorState {
  let bytes: string
  try {
    bytes = readFileSync(path, "utf8")
  } catch (error) {
    throw cursorError(path, `could not be read: ${error instanceof Error ? error.message : String(error)}`)
  }
  return parseGitHubWatchlistCursorState(bytes, path)
}

function writeCursorAtomic(path: string, state: GitHubWatchlistCursorState): void {
  const parent = dirname(path)
  mkdirSync(parent, { recursive: true })
  try {
    atomicWriteFileSync(path, canonicalCursorJson(state), 0o600)
  } catch (error) {
    throw cursorError(
      path,
      `could not be written atomically: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

export function openGitHubWatchlistCursorStore(options: { readonly stateDir: string }): GitHubWatchlistCursorStore {
  const path = resolve(options.stateDir, "github-watchlist-cursor.json")
  mkdirSync(options.stateDir, { recursive: true })
  using _lock = acquireFlockBlocking(`${path}.lock`)
  const state = existsSync(path) ? readCursor(path) : { items: {} }
  return {
    path,
    state,
    save(next) {
      using _saveLock = acquireFlockBlocking(`${path}.lock`)
      writeCursorAtomic(path, next)
    },
  }
}
