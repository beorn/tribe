/**
 * Machine-local, fail-loud persistence and target parsing for Tribe's GitHub watchlist.
 *
 * Shared between `tribe watch` (CLI) and `tribe-daemon`'s GitHub poller so both
 * validate the exact same URL/shorthand grammar, enforce the 100-item cap, and
 * serialize writes through one flock + atomic rename beside `github-cursor.json`.
 */
import { atomicWriteFileSync } from "@bearly/durable-file"
import { acquireFlockBlocking } from "@bearly/flock"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, resolve } from "node:path"
import { TRIBE_NAME_ENV, TRIBE_SESSION_NAME_ENV } from "../launch-environment.ts"
import { readIdentityTokenFromEnvironment, readUnverifiedTokenClaims } from "./identity-token.ts"

export const GITHUB_WATCHLIST_MAX_ITEMS = 100
export const GITHUB_WATCHLIST_EXPIRY_DAYS = 14
export const GITHUB_WATCHLIST_EXPIRY_MS = GITHUB_WATCHLIST_EXPIRY_DAYS * 24 * 60 * 60 * 1000

export type ParsedGitHubWatchTarget =
  | {
      readonly kind: "repo"
      readonly repo: string
      readonly canonical: string
      readonly key: string
    }
  | {
      readonly kind: "item"
      readonly repo: string
      readonly number: number
      readonly canonical: string
      readonly key: string
    }

export interface GitHubWatchEntry {
  readonly kind: "repo" | "item"
  readonly target: string
  readonly repo: string
  readonly number?: number
  readonly owner: string
  readonly operatorFollows: boolean
  readonly addedAt: string
}

export interface GitHubWatchlistState {
  readonly entries: readonly GitHubWatchEntry[]
}

export interface AddGitHubWatchInput {
  readonly target: string
  readonly owner: string
  readonly operatorFollows?: boolean
  readonly now?: string
}

export interface AddGitHubWatchResult {
  readonly action: "added" | "updated"
  readonly entry: GitHubWatchEntry
  readonly state: GitHubWatchlistState
}

export interface RemoveGitHubWatchResult {
  readonly removed: GitHubWatchEntry
  readonly state: GitHubWatchlistState
}

type WatchlistEnvironment = Readonly<Record<string, string | undefined>>

const ACCEPTED_TARGET_FORMS =
  "owner/repo, owner/repo#<number>, https://github.com/owner/repo, " +
  "https://github.com/owner/repo/issues/<number>, or https://github.com/owner/repo/pull/<number>"

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/u
const POSITIVE_INT_RE = /^[1-9][0-9]*$/u
const ALLOWED_PR_SUBPATHS = new Set(["files", "commits", "checks"])

function isValidOwnerAndRepo(owner: string, repo: string): boolean {
  if (!OWNER_RE.test(owner)) return false
  if (!REPO_RE.test(repo)) return false
  if (repo === "." || repo === "..") return false
  return true
}

function invalidTargetError(raw: string, detail: string): Error {
  return new Error(
    `Invalid GitHub watch target ${JSON.stringify(raw)}: ${detail}. Accepted forms: ${ACCEPTED_TARGET_FORMS}.`,
  )
}

function makeRepoTarget(owner: string, repo: string): ParsedGitHubWatchTarget {
  const full = `${owner}/${repo}`
  return { kind: "repo", repo: full, canonical: full, key: full.toLowerCase() }
}

function makeItemTarget(owner: string, repo: string, numberText: string, raw: string): ParsedGitHubWatchTarget {
  if (!POSITIVE_INT_RE.test(numberText)) {
    throw invalidTargetError(raw, `issue/PR number ${JSON.stringify(numberText)} must be a positive integer`)
  }
  const number = Number(numberText)
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw invalidTargetError(raw, `issue/PR number ${JSON.stringify(numberText)} is out of range`)
  }
  const full = `${owner}/${repo}`
  const canonical = `${full}#${number}`
  return { kind: "item", repo: full, number, canonical, key: canonical.toLowerCase() }
}

/**
 * Parse a GitHub repo or issue/PR watch target into its canonical form.
 * Refuses unrecognized URLs, non-github.com hosts, and invalid paths by name.
 */
export function parseGitHubWatchTarget(raw: string): ParsedGitHubWatchTarget {
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    throw invalidTargetError(raw, "target is empty")
  }

  if (trimmed.includes("://")) {
    let parsedUrl: URL
    try {
      parsedUrl = new URL(trimmed)
    } catch {
      throw invalidTargetError(raw, "malformed URL")
    }
    if (parsedUrl.protocol !== "https:") {
      throw invalidTargetError(raw, `unsupported protocol ${JSON.stringify(parsedUrl.protocol)} (expected https:)`)
    }
    const host = parsedUrl.hostname.toLowerCase()
    if (host !== "github.com" && host !== "www.github.com") {
      throw invalidTargetError(raw, `unsupported host ${JSON.stringify(parsedUrl.hostname)} (expected github.com)`)
    }
    const segments = parsedUrl.pathname.split("/").filter(Boolean)
    if (segments.length < 2) {
      throw invalidTargetError(raw, "URL must include owner and repository")
    }
    const owner = segments[0] ?? ""
    const rawRepo = segments[1] ?? ""
    const repo = segments.length === 2 && rawRepo.endsWith(".git") ? rawRepo.slice(0, -4) : rawRepo
    if (!isValidOwnerAndRepo(owner, repo)) {
      throw invalidTargetError(raw, `invalid owner/repo ${JSON.stringify(`${owner}/${rawRepo}`)}`)
    }
    if (segments.length === 2) {
      return makeRepoTarget(owner, repo)
    }
    const section = segments[2]
    const numberText = segments[3]
    if ((section === "issues" || section === "pull") && numberText !== undefined) {
      if (segments.length === 4) {
        return makeItemTarget(owner, repo, numberText, raw)
      }
      if (segments.length === 5 && section === "pull" && ALLOWED_PR_SUBPATHS.has(segments[4] ?? "")) {
        return makeItemTarget(owner, repo, numberText, raw)
      }
      throw invalidTargetError(raw, `unexpected path segments after ${section}/${numberText}`)
    }
    throw invalidTargetError(raw, `unsupported GitHub URL path ${JSON.stringify(parsedUrl.pathname)}`)
  }

  // Shorthand: owner/repo#123 or owner/repo
  if (/\s/u.test(trimmed)) {
    throw invalidTargetError(raw, "contains whitespace")
  }
  const hashIndex = trimmed.indexOf("#")
  if (hashIndex !== -1) {
    if (trimmed.indexOf("#", hashIndex + 1) !== -1) {
      throw invalidTargetError(raw, "contains multiple '#' characters")
    }
    const repoPart = trimmed.slice(0, hashIndex)
    const numberPart = trimmed.slice(hashIndex + 1)
    const parts = repoPart.split("/")
    if (parts.length !== 2) {
      throw invalidTargetError(raw, "expected owner/repo#<number>")
    }
    const owner = parts[0] ?? ""
    const repo = parts[1] ?? ""
    if (!isValidOwnerAndRepo(owner, repo)) {
      throw invalidTargetError(raw, `invalid owner/repo ${JSON.stringify(repoPart)}`)
    }
    return makeItemTarget(owner, repo, numberPart, raw)
  }

  const parts = trimmed.split("/")
  if (parts.length !== 2) {
    throw invalidTargetError(raw, "expected owner/repo or a full https://github.com/... URL")
  }
  const owner = parts[0] ?? ""
  const repo = parts[1] ?? ""
  if (!isValidOwnerAndRepo(owner, repo)) {
    throw invalidTargetError(raw, `invalid owner/repo ${JSON.stringify(trimmed)}`)
  }
  return makeRepoTarget(owner, repo)
}

export function resolveGitHubWatchlistPath(env: WatchlistEnvironment = process.env): string {
  const dataHome = env.XDG_DATA_HOME?.trim() || resolve(env.HOME?.trim() || homedir(), ".local/share")
  return resolve(dataHome, "tribe", "github-watchlist.json")
}

export function resolveDefaultWatchOwner(env: WatchlistEnvironment = process.env): string {
  const token = readIdentityTokenFromEnvironment(env)
  if (token) {
    const actor = readUnverifiedTokenClaims(token).actor.trim()
    if (actor.length > 0) return actor
  }
  const explicit = env[TRIBE_NAME_ENV]?.trim() || env[TRIBE_SESSION_NAME_ENV]?.trim()
  if (explicit) return explicit
  throw new Error(
    `Could not determine an owning seat from launch identity (${TRIBE_NAME_ENV}/${TRIBE_SESSION_NAME_ENV} unset). ` +
      `Pass --owner <seat> explicitly (for example: --owner @dev/15).`,
  )
}

export function watchEntryKey(entry: Pick<GitHubWatchEntry, "target">): string {
  return entry.target.toLowerCase()
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Reflect.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function watchlistError(path: string, detail: string): Error {
  return new Error(`GitHub watchlist ${path} ${detail}`)
}

export function parseGitHubWatchlistState(bytes: string, path: string): GitHubWatchlistState {
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes)
  } catch (error) {
    throw watchlistError(path, `is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (
    !isPlainObject(parsed) ||
    !Array.isArray(parsed.entries) ||
    Object.keys(parsed).some((key) => key !== "entries")
  ) {
    throw watchlistError(path, 'must be an object with exactly one "entries" array')
  }

  const entries: GitHubWatchEntry[] = []
  const seenKeys = new Set<string>()
  for (let i = 0; i < parsed.entries.length; i++) {
    const raw: unknown = parsed.entries[i]
    if (!isPlainObject(raw)) {
      throw watchlistError(path, `entry[${i}] must be a JSON object`)
    }
    const kind = raw.kind
    if (kind !== "repo" && kind !== "item") {
      throw watchlistError(path, `entry[${i}].kind must be "repo" or "item"`)
    }
    if (typeof raw.target !== "string" || raw.target.trim().length === 0) {
      throw watchlistError(path, `entry[${i}].target must be a non-empty string`)
    }
    const parsedTarget = parseGitHubWatchTarget(raw.target)
    if (parsedTarget.kind !== kind) {
      throw watchlistError(
        path,
        `entry[${i}] target ${JSON.stringify(raw.target)} has kind ${parsedTarget.kind}, not ${kind}`,
      )
    }
    if (typeof raw.owner !== "string" || raw.owner.trim().length === 0) {
      throw watchlistError(path, `entry[${i}].owner must be a non-empty seat name`)
    }
    if (typeof raw.operatorFollows !== "boolean") {
      throw watchlistError(path, `entry[${i}].operatorFollows must be a boolean`)
    }
    if (typeof raw.addedAt !== "string" || Number.isNaN(Date.parse(raw.addedAt))) {
      throw watchlistError(path, `entry[${i}].addedAt must be a valid ISO-8601 timestamp`)
    }
    if (seenKeys.has(parsedTarget.key)) {
      throw watchlistError(path, `contains duplicate entry for ${parsedTarget.canonical}`)
    }
    seenKeys.add(parsedTarget.key)
    entries.push({
      kind: parsedTarget.kind,
      target: parsedTarget.canonical,
      repo: parsedTarget.repo,
      ...(parsedTarget.kind === "item" ? { number: parsedTarget.number } : {}),
      owner: raw.owner.trim(),
      operatorFollows: raw.operatorFollows,
      addedAt: raw.addedAt,
    })
  }
  return { entries }
}

function canonicalWatchlistJson(state: GitHubWatchlistState): string {
  const sorted = [...state.entries].sort((left, right) => left.target.localeCompare(right.target))
  const validated = parseGitHubWatchlistState(JSON.stringify({ entries: sorted }), "<in-memory>")
  return `${JSON.stringify({ entries: validated.entries }, null, 2)}\n`
}

/**
 * Read the watchlist file. An absent file is an explicit empty watchlist;
 * any unreadable or malformed file throws loud.
 */
export function readGitHubWatchlist(path: string): GitHubWatchlistState {
  if (!existsSync(path)) {
    return { entries: [] }
  }
  let bytes: string
  try {
    bytes = readFileSync(path, "utf8")
  } catch (error) {
    throw watchlistError(path, `could not be read: ${error instanceof Error ? error.message : String(error)}`)
  }
  return parseGitHubWatchlistState(bytes, path)
}

function writeWatchlistAtomic(path: string, state: GitHubWatchlistState): void {
  const parent = dirname(path)
  mkdirSync(parent, { recursive: true })
  try {
    atomicWriteFileSync(path, canonicalWatchlistJson(state), 0o600)
  } catch (error) {
    throw watchlistError(
      path,
      `could not be written atomically: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

export function addGitHubWatchEntry(
  path: string,
  input: AddGitHubWatchInput,
  options: { readonly maxItems?: number } = {},
): AddGitHubWatchResult {
  const parsed = parseGitHubWatchTarget(input.target)
  const owner = input.owner.trim()
  if (owner.length === 0) {
    throw new Error(`Cannot watch ${parsed.canonical}: owner seat is empty. Pass --owner <seat>.`)
  }
  const maxItems = options.maxItems ?? GITHUB_WATCHLIST_MAX_ITEMS
  const parent = dirname(path)
  mkdirSync(parent, { recursive: true })
  using _lock = acquireFlockBlocking(`${path}.lock`)

  const current = readGitHubWatchlist(path)
  const existingIndex = current.entries.findIndex((entry) => watchEntryKey(entry) === parsed.key)
  const now = input.now ?? new Date().toISOString()

  if (existingIndex !== -1) {
    const existing = current.entries[existingIndex]
    if (existing === undefined) {
      throw new Error(`Internal watchlist index error for ${parsed.canonical}`)
    }
    const updated: GitHubWatchEntry = {
      kind: parsed.kind,
      target: parsed.canonical,
      repo: parsed.repo,
      ...(parsed.kind === "item" ? { number: parsed.number } : {}),
      owner,
      operatorFollows: input.operatorFollows ?? existing.operatorFollows,
      addedAt: existing.addedAt,
    }
    const nextEntries = [...current.entries]
    nextEntries[existingIndex] = updated
    const nextState: GitHubWatchlistState = { entries: nextEntries }
    writeWatchlistAtomic(path, nextState)
    return { action: "updated", entry: updated, state: nextState }
  }

  if (parsed.kind === "item") {
    const items = current.entries.filter((entry) => entry.kind === "item")
    if (items.length >= maxItems) {
      const oldest = [...items]
        .sort((left, right) => left.addedAt.localeCompare(right.addedAt))
        .slice(0, 5)
        .map((entry) => `${entry.target} (${entry.owner}, added ${entry.addedAt.slice(0, 10)})`)
        .join(", ")
      throw new Error(
        `GitHub watchlist cap reached (${items.length}/${maxItems} watched items); refusing to add ${parsed.canonical}. ` +
          `Oldest watched items: ${oldest}. Remove one first with \`tribe watch remove <target>\`.`,
      )
    }
  }

  const entry: GitHubWatchEntry = {
    kind: parsed.kind,
    target: parsed.canonical,
    repo: parsed.repo,
    ...(parsed.kind === "item" ? { number: parsed.number } : {}),
    owner,
    operatorFollows: input.operatorFollows ?? false,
    addedAt: now,
  }
  const nextState: GitHubWatchlistState = { entries: [...current.entries, entry] }
  writeWatchlistAtomic(path, nextState)
  return { action: "added", entry, state: nextState }
}

export function removeGitHubWatchEntry(path: string, rawTarget: string): RemoveGitHubWatchResult {
  const parsed = parseGitHubWatchTarget(rawTarget)
  const parent = dirname(path)
  mkdirSync(parent, { recursive: true })
  using _lock = acquireFlockBlocking(`${path}.lock`)

  const current = readGitHubWatchlist(path)
  const index = current.entries.findIndex((entry) => watchEntryKey(entry) === parsed.key)
  if (index === -1) {
    throw new Error(`GitHub watchlist ${path} is not watching ${parsed.canonical}`)
  }
  const removed = current.entries[index]
  if (removed === undefined) {
    throw new Error(`Internal watchlist index error removing ${parsed.canonical}`)
  }
  const nextState: GitHubWatchlistState = {
    entries: current.entries.filter((_, i) => i !== index),
  }
  writeWatchlistAtomic(path, nextState)
  return { removed, state: nextState }
}

export function removeGitHubWatchEntriesByKey(path: string, keys: ReadonlySet<string>): GitHubWatchEntry[] {
  if (keys.size === 0 || !existsSync(path)) return []
  const parent = dirname(path)
  mkdirSync(parent, { recursive: true })
  using _lock = acquireFlockBlocking(`${path}.lock`)

  const current = readGitHubWatchlist(path)
  const removed: GitHubWatchEntry[] = []
  const kept: GitHubWatchEntry[] = []
  for (const entry of current.entries) {
    if (keys.has(watchEntryKey(entry))) {
      removed.push(entry)
    } else {
      kept.push(entry)
    }
  }
  if (removed.length > 0) {
    writeWatchlistAtomic(path, { entries: kept })
  }
  return removed
}
