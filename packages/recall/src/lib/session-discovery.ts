/**
 * session-discovery.ts — Find the active agent session across ALL transcript
 * roots, not just `~/.claude/projects`.
 *
 * Why this exists: `current-brief` used to look only under
 * `~/.claude/projects/<cwd-slug>` and pick the most-recently-modified JSONL
 * there. When the live session is a Codex run (plain `codex` CLI or an
 * `ag` profile seat), that root has no matching file, so the heuristic fell
 * back to an unrelated, stale Claude transcript in the same project slug —
 * chief recovery then read the wrong context and silently lost the thread.
 *
 * This module enumerates every known transcript root, parses each format's
 * cwd + activity time, picks the freshest candidate whose cwd matches the
 * caller's, and ALWAYS returns diagnostics (searched roots, candidate counts,
 * the chosen path, freshness, and exclusion reasons) so an empty/wrong-session
 * outcome is explained loudly rather than failing silently.
 *
 * Transcript roots covered:
 *   - ~/.claude/projects/<slug>/*.jsonl                          (Claude Code)
 *   - ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl               (Codex CLI)
 *   - ~/.config/ag/profiles/<provider>/<account>/...             (ag profiles)
 *
 * ag-profile roots are discovered provider-agnostically: every subdir of
 * `~/.config/ag/profiles` is treated as a provider, mapped to a session layout
 * via PROVIDER_ADAPTERS (claude → projects/, codex → sessions/). A provider ag
 * can route but recall has no adapter for (e.g. `grok`) is reported as an
 * unsupported provider rather than silently skipped, so recall never quietly
 * degrades into a Claude/Codex-only memory surface. Roots that resolve to the
 * same real directory (the shared Claude store reached via a profile symlink)
 * are deduped so candidate counts stay honest.
 */

import * as fs from "fs"
import * as path from "path"
import * as os from "os"

// ============================================================================
// Types
// ============================================================================

export type SessionFormat = "claude" | "codex"

export interface SessionRoot {
  /** Absolute directory that holds session transcripts. */
  dir: string
  format: SessionFormat
  /** Human label for diagnostics, e.g. "claude", "ag-codex:d@delei.org". */
  kind: string
}

export interface SessionCandidate {
  sessionId: string
  path: string
  format: SessionFormat
  /** Working directory the session ran in (decoded from slug or session_meta). */
  cwd: string | null
  /** File mtime in ms — the activity proxy used for ranking. */
  mtimeMs: number
  /** Diagnostic label of the root this came from. */
  rootKind: string
}

/**
 * A provider that ag can route (a configured `~/.config/ag/profiles/<provider>`
 * with ≥1 account) but recall has no transcript adapter for — so its sessions
 * are NOT searched. Surfaced loudly instead of being silently skipped.
 */
export interface UnsupportedProvider {
  /** Provider dir name under `~/.config/ag/profiles`. */
  provider: string
  /** Absolute provider directory. */
  dir: string
  /** Configured account subdirs (proof the provider is actually set up). */
  accountCount: number
  /** Fail-loud explanation of why recall cannot read this provider. */
  reason: string
}

export interface SessionDiscoveryDiagnostics {
  cwd: string
  /** Roots that existed and were scanned. */
  searchedRoots: string[]
  /** Roots that did not exist (skipped). */
  missingRoots: string[]
  /**
   * Roots skipped because they resolve to an already-scanned real directory —
   * e.g. an ag Claude profile whose `projects/` symlinks into the shared stock
   * store (@km/accounts 19850). Reported so the dedup is visible, not silent.
   */
  dedupedRoots: string[]
  /** ag providers configured but unsupported by recall (no transcript adapter). */
  unsupportedProviders: UnsupportedProvider[]
  /** Total transcript files inspected across all roots (within the scan window). */
  candidateCount: number
  /** Candidates whose cwd matched the caller's cwd. */
  matchedCount: number
  /** The chosen session, if any. */
  chosen: {
    path: string
    sessionId: string
    format: SessionFormat
    rootKind: string
    ageMs: number
  } | null
  /** Human-readable reasons candidates were excluded. */
  exclusions: string[]
}

export interface DiscoverOptions {
  cwd: string
  /** Override home dir (tests). Defaults to os.homedir(). */
  homeDir?: string
  /** Ignore files not modified within this window (cheap mtime prefilter). Default 24h. */
  scanWindowMs?: number
  /** Max codex files to deep-inspect per root, newest first. Default 80. */
  maxCodexInspect?: number
  /** Injectable clock for tests. Defaults to Date.now(). */
  now?: number
}

export interface SessionDiscoveryResult {
  candidate: SessionCandidate | null
  diagnostics: SessionDiscoveryDiagnostics
}

const DAY_MS = 24 * 60 * 60 * 1000

// ============================================================================
// Provider adapters + root enumeration
// ============================================================================

/** How recall reads one ag provider's session store. */
interface ProviderAdapter {
  /** Session-store subdir under the profile home (e.g. "projects", "sessions"). */
  sessionSubdir: string
  format: SessionFormat
}

/**
 * The authoritative ag provider/profile-home convention lives in `@km/accounts`
 * (`AccountProfileProvider = "claude" | "codex" | "grok"`, profiles under
 * `~/.config/ag/profiles/<provider>/<account>/`). recall is a standalone
 * package and cannot import that workspace module, so the layout knowledge it
 * needs for *session discovery* is mirrored here. Keep this table in sync when
 * `@km/accounts` adds a provider whose on-disk session format is known.
 *
 * A provider ag can route but recall has no adapter for (e.g. `grok` today) is
 * reported as an {@link UnsupportedProvider} — loudly, never silently skipped.
 */
const PROVIDER_ADAPTERS: Record<string, ProviderAdapter> = {
  claude: { sessionSubdir: "projects", format: "claude" },
  codex: { sessionSubdir: "sessions", format: "codex" },
  // grok: routed by ag, but recall has no transcript adapter yet → unsupported.
}

export interface RootEnumeration {
  roots: SessionRoot[]
  unsupported: UnsupportedProvider[]
}

/**
 * Enumerate every transcript root recall can read, plus any ag provider that is
 * configured but has no recall adapter. The native Claude/Codex roots are
 * always included (even if absent, so diagnostics can report them). ag-profile
 * roots are discovered generically: each subdir of `~/.config/ag/profiles` is a
 * provider — supported providers contribute one root per account; an
 * unsupported provider with ≥1 configured account is reported for a loud
 * diagnostic instead of being silently ignored.
 */
export function enumerateRoots(homeDir: string): RootEnumeration {
  const roots: SessionRoot[] = [
    { dir: path.join(homeDir, ".claude", "projects"), format: "claude", kind: "claude" },
    { dir: path.join(homeDir, ".codex", "sessions"), format: "codex", kind: "codex" },
  ]
  const unsupported: UnsupportedProvider[] = []

  const agBase = path.join(homeDir, ".config", "ag", "profiles")
  for (const provider of listSubdirs(agBase).sort()) {
    const providerDir = path.join(agBase, provider)
    const accounts = listSubdirs(providerDir)
    const adapter = PROVIDER_ADAPTERS[provider]
    if (adapter) {
      for (const account of accounts) {
        roots.push({
          dir: path.join(providerDir, account, adapter.sessionSubdir),
          format: adapter.format,
          kind: `ag-${provider}:${account}`,
        })
      }
    } else if (accounts.length > 0) {
      unsupported.push({
        provider,
        dir: providerDir,
        accountCount: accounts.length,
        reason:
          `ag provider "${provider}" is configured (${accounts.length} account(s)) but recall has no ` +
          `session-format adapter for it — its transcripts are NOT searched. Add an entry to ` +
          `PROVIDER_ADAPTERS in session-discovery.ts once its on-disk session layout is known.`,
      })
    }
  }
  return { roots, unsupported }
}

/**
 * Backward-compatible supported-root list. Prefer {@link enumerateRoots} when
 * you also need unsupported-provider diagnostics.
 */
export function sessionRoots(homeDir: string): SessionRoot[] {
  return enumerateRoots(homeDir).roots
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Discover the active session for `cwd` across all transcript roots.
 * Never throws; always returns diagnostics describing what was searched and
 * why the result is what it is.
 */
export function discoverActiveSession(opts: DiscoverOptions): SessionDiscoveryResult {
  const homeDir = opts.homeDir ?? os.homedir()
  const now = opts.now ?? Date.now()
  const scanWindowMs = opts.scanWindowMs ?? DAY_MS
  const maxCodexInspect = opts.maxCodexInspect ?? 80
  const cwd = opts.cwd

  const { roots, unsupported } = enumerateRoots(homeDir)
  const searchedRoots: string[] = []
  const missingRoots: string[] = []
  const dedupedRoots: string[] = []
  const exclusions: string[] = []
  const matched: SessionCandidate[] = []
  const seenReal = new Set<string>()
  let candidateCount = 0

  for (const root of roots) {
    if (!fs.existsSync(root.dir)) {
      missingRoots.push(`${root.kind} (${tilde(root.dir, homeDir)})`)
      continue
    }
    // Dedup roots that resolve to the same real directory — e.g. an ag Claude
    // profile whose `projects/` symlinks into the shared stock store
    // (@km/accounts 19850). Without this the shared store is scanned once per
    // profile and candidate counts double. Native roots are listed first, so
    // they win and the symlinked profile copies are the ones dropped.
    const real = realpathOrNull(root.dir)
    if (real !== null) {
      if (seenReal.has(real)) {
        dedupedRoots.push(`${root.kind} (${tilde(root.dir, homeDir)} → ${tilde(real, homeDir)})`)
        continue
      }
      seenReal.add(real)
    }
    searchedRoots.push(`${root.kind} (${tilde(root.dir, homeDir)})`)

    if (root.format === "claude") {
      const { inspected, matched: m } = claudeCandidates(root, cwd, now, scanWindowMs)
      candidateCount += inspected
      matched.push(...m)
    } else {
      const {
        inspected,
        matched: m,
        cwdMismatch,
        stale,
      } = codexCandidates(root, cwd, now, scanWindowMs, maxCodexInspect)
      candidateCount += inspected
      matched.push(...m)
      if (cwdMismatch > 0) exclusions.push(`${root.kind}: ${cwdMismatch} session(s) excluded — cwd mismatch`)
      if (stale > 0)
        exclusions.push(`${root.kind}: ${stale} session(s) skipped — not modified in ${fmtDur(scanWindowMs)}`)
    }
  }

  // Rank matched candidates by activity (mtime) descending; freshest wins.
  matched.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const chosen = matched[0] ?? null

  if (chosen && matched.length > 1) {
    exclusions.push(
      `${matched.length - 1} older matching session(s) not chosen (freshest is ${chosen.rootKind} ${chosen.sessionId.slice(0, 8)})`,
    )
  }

  const diagnostics: SessionDiscoveryDiagnostics = {
    cwd,
    searchedRoots,
    missingRoots,
    dedupedRoots,
    unsupportedProviders: unsupported,
    candidateCount,
    matchedCount: matched.length,
    chosen: chosen
      ? {
          path: chosen.path,
          sessionId: chosen.sessionId,
          format: chosen.format,
          rootKind: chosen.rootKind,
          ageMs: now - chosen.mtimeMs,
        }
      : null,
    exclusions,
  }

  return { candidate: chosen, diagnostics }
}

/** Render discovery diagnostics as a compact, human-readable block. */
export function renderDiscoveryDiagnostics(d: SessionDiscoveryDiagnostics): string {
  const lines: string[] = []
  lines.push(`cwd: ${d.cwd}`)
  lines.push(`searched ${d.searchedRoots.length} root(s): ${d.searchedRoots.join("; ") || "(none)"}`)
  if (d.missingRoots.length > 0) lines.push(`absent root(s): ${d.missingRoots.join("; ")}`)
  if (d.dedupedRoots.length > 0) lines.push(`deduped root(s): ${d.dedupedRoots.join("; ")}`)
  if (d.unsupportedProviders.length > 0) {
    lines.push("unsupported provider(s):")
    for (const u of d.unsupportedProviders) lines.push(`  - ${u.provider} (${u.accountCount} account(s)): ${u.reason}`)
  }
  lines.push(`candidates inspected: ${d.candidateCount}, cwd-matched: ${d.matchedCount}`)
  if (d.chosen) {
    lines.push(
      `chosen: ${d.chosen.sessionId.slice(0, 8)} [${d.chosen.format}/${d.chosen.rootKind}] age ${Math.round(d.chosen.ageMs / 60_000)}m`,
    )
    lines.push(`  path: ${d.chosen.path}`)
  } else {
    lines.push("chosen: (none)")
  }
  if (d.exclusions.length > 0) {
    lines.push("exclusions:")
    for (const e of d.exclusions) lines.push(`  - ${e}`)
  }
  return lines.join("\n")
}

// ============================================================================
// Claude roots — projects/<slug>/*.jsonl, slug = cwd with "/" → "-"
// ============================================================================

function claudeCandidates(
  root: SessionRoot,
  cwd: string,
  now: number,
  scanWindowMs: number,
): { inspected: number; matched: SessionCandidate[] } {
  const matched: SessionCandidate[] = []
  let inspected = 0

  // Walk cwd then parents — a caller in a subdir still finds the project root.
  let dir = cwd
  for (let i = 0; i < 6; i++) {
    const slug = dir.replaceAll("/", "-")
    const projectDir = path.join(root.dir, slug)
    if (fs.existsSync(projectDir)) {
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(projectDir, { withFileTypes: true })
      } catch {
        // silent-fallback-allow: unreadable project dir contributes no candidates.
        entries = []
      }
      for (const e of entries) {
        if (!e.isFile() || !e.name.endsWith(".jsonl")) continue
        const full = path.join(projectDir, e.name)
        let mtimeMs: number
        try {
          mtimeMs = fs.statSync(full).mtimeMs
        } catch {
          continue
        }
        inspected++
        if (now - mtimeMs > scanWindowMs) continue
        matched.push({
          sessionId: path.basename(e.name, ".jsonl"),
          path: full,
          format: "claude",
          cwd: dir,
          mtimeMs,
          rootKind: root.kind,
        })
      }
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  return { inspected, matched }
}

// ============================================================================
// Codex roots — sessions/YYYY/MM/DD/rollout-*.jsonl, cwd lives in session_meta
// ============================================================================

function codexCandidates(
  root: SessionRoot,
  cwd: string,
  now: number,
  scanWindowMs: number,
  maxInspect: number,
): { inspected: number; matched: SessionCandidate[]; cwdMismatch: number; stale: number } {
  const files = recentDatedFiles(root.dir, now, scanWindowMs, maxInspect)
  const matched: SessionCandidate[] = []
  let cwdMismatch = 0
  let stale = 0

  for (const f of files) {
    if (now - f.mtimeMs > scanWindowMs) {
      stale++
      continue
    }
    const meta = readCodexSessionMeta(f.path)
    if (!meta) continue
    if (!cwdMatches(meta.cwd, cwd)) {
      cwdMismatch++
      continue
    }
    matched.push({
      sessionId: meta.id ?? path.basename(f.path, ".jsonl"),
      path: f.path,
      format: "codex",
      cwd: meta.cwd,
      mtimeMs: f.mtimeMs,
      rootKind: root.kind,
    })
  }

  return { inspected: files.length, matched, cwdMismatch, stale }
}

/**
 * Collect `.jsonl` files under a date-partitioned root (YYYY/MM/DD), newest
 * first, descending only the most-recent date directories so we never walk
 * years of history. Bounded by `maxInspect`.
 */
function recentDatedFiles(
  rootDir: string,
  now: number,
  scanWindowMs: number,
  maxInspect: number,
): { path: string; mtimeMs: number }[] {
  const out: { path: string; mtimeMs: number }[] = []

  // Date dirs are zero-padded, so reverse-lexicographic == newest-first.
  const years = listSubdirs(rootDir).sort().reverse()
  for (const y of years) {
    const yDir = path.join(rootDir, y)
    const months = listSubdirs(yDir).sort().reverse()
    for (const m of months) {
      const mDir = path.join(yDir, m)
      const days = listSubdirs(mDir).sort().reverse()
      for (const d of days) {
        const dDir = path.join(mDir, d)
        let entries: fs.Dirent[]
        try {
          entries = fs.readdirSync(dDir, { withFileTypes: true })
        } catch {
          continue
        }
        for (const e of entries) {
          if (!e.isFile() || !e.name.endsWith(".jsonl")) continue
          const full = path.join(dDir, e.name)
          try {
            out.push({ path: full, mtimeMs: fs.statSync(full).mtimeMs })
          } catch {
            /* skip unreadable */
          }
        }
        // Stop once we've gathered enough fresh files from recent day dirs.
        if (out.length >= maxInspect && out.some((f) => now - f.mtimeMs <= scanWindowMs)) {
          out.sort((a, b) => b.mtimeMs - a.mtimeMs)
          return out.slice(0, maxInspect)
        }
      }
    }
  }

  out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return out.slice(0, maxInspect)
}

interface CodexMeta {
  id: string | null
  cwd: string | null
}

/** Read the first `session_meta` line of a Codex rollout file. */
function readCodexSessionMeta(filepath: string): CodexMeta | null {
  let head: string
  try {
    head = readHead(filepath, 64 * 1024)
  } catch {
    // silent-fallback-allow: unreadable codex head means no session meta.
    return null
  }
  for (const line of head.split("\n")) {
    if (!line.trim()) continue
    let obj: unknown
    try {
      obj = JSON.parse(line)
    } catch {
      // silent-fallback-allow: a first line that won't parse means the read
      // window truncated it or this isn't a codex rollout — session_meta is
      // always line 1, so there is nothing further to recover here.
      return null
    }
    if (!obj || typeof obj !== "object") return null
    const rec = obj as { type?: string; payload?: { id?: unknown; cwd?: unknown } }
    if (rec.type === "session_meta" && rec.payload) {
      return {
        id: typeof rec.payload.id === "string" ? rec.payload.id : null,
        cwd: typeof rec.payload.cwd === "string" ? rec.payload.cwd : null,
      }
    }
    // session_meta is the first record; if line 1 isn't it, this isn't a
    // recognizable codex rollout — bail rather than scan the whole file.
    return null
  }
  return null
}

// ============================================================================
// Shared helpers
// ============================================================================

/** cwd match: equal, or one is an ancestor of the other. */
export function cwdMatches(sessionCwd: string | null, targetCwd: string): boolean {
  if (!sessionCwd) return false
  if (sessionCwd === targetCwd) return true
  const a = sessionCwd.endsWith("/") ? sessionCwd : sessionCwd + "/"
  const b = targetCwd.endsWith("/") ? targetCwd : targetCwd + "/"
  return b.startsWith(a) || a.startsWith(b)
}

/** Resolve a path's real (symlink-followed) location, or null if it can't be read. */
function realpathOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p)
  } catch {
    // silent-fallback-allow: a path we cannot realpath is scanned without dedup.
    return null
  }
}

function listSubdirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    // silent-fallback-allow: a missing root simply has no subdirs.
    return []
  }
}

/** Read the first `bytes` of a file as UTF-8 (for cheap header parsing). */
function readHead(filepath: string, bytes: number): string {
  const stat = fs.statSync(filepath)
  const len = Math.min(stat.size, bytes)
  if (len === 0) return ""
  const fd = fs.openSync(filepath, "r")
  try {
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, 0)
    return buf.toString("utf8")
  } finally {
    fs.closeSync(fd)
  }
}

function tilde(p: string, homeDir: string): string {
  return p.startsWith(homeDir) ? "~" + p.slice(homeDir.length) : p
}

function fmtDur(ms: number): string {
  const h = Math.round(ms / (60 * 60 * 1000))
  if (h >= 24 && h % 24 === 0) return `${h / 24}d`
  return `${h}h`
}
