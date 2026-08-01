#!/usr/bin/env bun
/**
 * qmd transcript export adapter for the canonical Recall CLI.
 *
 * When RECALL_SESSIONS_DIR and RECALL_REJECTED_DIR are explicitly set,
 * exports Claude Code session JSONLs as plain markdown for qmd collections.
 * Interactive search, indexing, status, and prompt hooks belong to the
 * canonical FTS-backed CLI and `tribe hook`; this module must not grow a
 * second dispatcher for them.
 *
 * Design notes:
 *   - Session markdown is the source of truth for everything except the live
 *     JSONL files. qmd indexes it via its post-commit hook + `qmd update`.
 *   - Output filename: YYYY-MM-DDTHHMM-<slug>.md (per EPIC - Knowledge Infra plan).
 *   - Idempotent: existing output files are skipped unless --force.
 *   - SessionEnd hook mode emits the event's valid empty response after the
 *     export side effect.
 */
import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync, openSync, readSync, closeSync } from "node:fs"
import { StringDecoder } from "node:string_decoder"
import { join, resolve } from "node:path"
import { homedir } from "node:os"
import { spawn } from "node:child_process"
import { emitHookJson as envelopeEmitHookJson } from "../../injection-envelope/src/index.ts"
// Reject corrupted/decayed/stuck-loop exports before they reach qmd.
import { analyzeQuality } from "./lib/quality-gate.ts"

const HOME = homedir()
const CLAUDE_PROJECTS_DIR = `${HOME}/.claude/projects`
const QMD = "qmd"

interface ExportDirs {
  sessionsDir: string
  rejectedDir: string
}

function explicitEnv(name: "RECALL_SESSIONS_DIR" | "RECALL_REJECTED_DIR"): string | undefined {
  const value = process.env[name]?.trim()
  return value ? value : undefined
}

function resolveExportDirs(isHook: boolean): ExportDirs | undefined {
  const sessionsDir = explicitEnv("RECALL_SESSIONS_DIR")
  const rejectedDir = explicitEnv("RECALL_REJECTED_DIR")
  const missing = [
    sessionsDir ? undefined : "RECALL_SESSIONS_DIR",
    rejectedDir ? undefined : "RECALL_REJECTED_DIR",
  ].filter((name): name is string => Boolean(name))

  if (sessionsDir && rejectedDir) return { sessionsDir, rejectedDir }

  const message = `recall export: ${missing.join(" and ")} required; no default export directory is used`
  if (isHook) {
    process.stderr.write(`${message}; skipping export\n`)
    return undefined
  }

  process.stderr.write(`${message}\n`)
  process.exit(2)
}

// ── JSONL session parsing ────────────────────────────────────────────────

interface ContentBlock {
  type: string
  text?: string
  name?: string
}

interface JsonlEntry {
  type?: string
  sessionId?: string
  timestamp?: string
  cwd?: string
  message?: {
    role?: "user" | "assistant" | "system"
    content?: string | ContentBlock[]
  }
}

function extractText(entry: JsonlEntry): string {
  const content = entry.message?.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("\n")
  }
  return ""
}

interface SessionMeta {
  sessionId: string
  jsonlPath: string
  startTime: Date
  project: string
  firstUserText: string
}

/**
 * Stream a jsonl file line-by-line through a bounded 256KB read buffer.
 * Blank lines are skipped. The callback may return `false` to stop the
 * scan early.
 *
 * This exists because `--catchup` runs on every Claude SessionStart over
 * EVERY transcript under ~/.claude/projects (multi-GB corpora are normal).
 * The previous whole-file `readFileSync` + `split("\n")` materialized ≥4x
 * each file's bytes in JS heap inside a tight sync loop — RSS climbed to
 * ~7GB and tripped Silver Code's ACP backend RSS watchdog, killing the
 * session right after `--resume` (km bead 19775).
 */
export function forEachJsonlLine(path: string, onLine: (line: string) => boolean | undefined | void): void {
  const fd = openSync(path, "r")
  try {
    // StringDecoder carries partial multi-byte UTF-8 sequences across
    // chunk boundaries — a bare toString() would emit U+FFFD there.
    const decoder = new StringDecoder("utf8")
    const chunk = Buffer.alloc(256 * 1024)
    let carry = ""
    for (;;) {
      const n = readSync(fd, chunk, 0, chunk.length, null)
      if (n <= 0) break
      carry += decoder.write(chunk.subarray(0, n))
      let nl: number
      while ((nl = carry.indexOf("\n")) >= 0) {
        const line = carry.slice(0, nl)
        carry = carry.slice(nl + 1)
        if (line.trim().length === 0) continue
        if (onLine(line) === false) return
      }
    }
    carry += decoder.end()
    if (carry.trim().length > 0) onLine(carry)
  } finally {
    closeSync(fd)
  }
}

export function readSessionMeta(jsonlPath: string): SessionMeta | undefined {
  let sessionId = ""
  let startTime: Date | undefined
  let project = ""
  let firstUserText = ""

  try {
    forEachJsonlLine(jsonlPath, (line) => {
      let entry: JsonlEntry
      try {
        entry = JSON.parse(line) as JsonlEntry
      } catch {
        return
      }
      if (!sessionId && entry.sessionId) sessionId = entry.sessionId
      if (!startTime && entry.timestamp) startTime = new Date(entry.timestamp)
      if (!project && entry.cwd) project = entry.cwd
      if (!firstUserText && entry.type === "user") {
        const txt = extractText(entry).trim()
        // Skip synthetic system-generated user turns (tool results, reminders)
        if (txt && !txt.startsWith("<") && !txt.startsWith("[")) {
          firstUserText = txt.slice(0, 200)
        }
      }
      // Every field is first-write-wins, so once all are known no later line
      // can change the result — stop reading. (messageCount, the one field
      // that needed a full scan, moved into renderSessionMarkdown, which only
      // runs for sessions that actually get exported.)
      if (sessionId && startTime && project && firstUserText) return false
      return
    })
  } catch {
    // silent-fallback-allow: unreadable transcript cannot contribute qmd session metadata.
    return undefined
  }

  if (!sessionId || !startTime) return undefined
  return { sessionId, jsonlPath, startTime, project, firstUserText }
}

export function slugFromText(text: string): string {
  const clean = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  const words = clean.split(" ").slice(0, 8).join("-")
  return words.slice(0, 50) || "session"
}

function sessionFilename(meta: SessionMeta): string {
  const d = meta.startTime
  const pad = (n: number) => String(n).padStart(2, "0")
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const time = `${pad(d.getHours())}${pad(d.getMinutes())}`
  const slug = slugFromText(meta.firstUserText)
  return `${date}T${time}-${slug}.md`
}

// ── markdown rendering ───────────────────────────────────────────────────

export function renderSessionMarkdown(meta: SessionMeta): string {
  // One streamed pass: count user/assistant entries (frontmatter `messages:`)
  // and collect the visible body. Counting happens BEFORE the contamination /
  // empty-text / synthetic-turn filters — identical semantics to the legacy
  // whole-file readSessionMeta counter.
  let messageCount = 0
  const body: string[] = []
  forEachJsonlLine(meta.jsonlPath, (line) => {
    let entry: JsonlEntry
    try {
      entry = JSON.parse(line) as JsonlEntry
    } catch {
      return
    }
    if (entry.type === "user" || entry.type === "assistant") messageCount++
    if (entry.type !== "user" && entry.type !== "assistant" && entry.type !== "system") return
    // Cross-session contamination guard. Claude Code occasionally writes
    // entries from a different sessionId into a JSONL — when this happens,
    // the rendered markdown ends up with fragments from unrelated sessions
    // joined mid-conversation, which then gets indexed and surfaces as
    // jumbled "memory" hits. Filter to entries that match the file's primary
    // sessionId (set by the first-seen entry in readSessionMeta).
    if (entry.sessionId && entry.sessionId !== meta.sessionId) return
    const text = extractText(entry).trim()
    if (!text) return
    // Skip synthetic user turns that are just tool results wrapped as user
    if (entry.type === "user" && (text.startsWith("<") || text.startsWith("["))) return
    const heading = entry.type === "user" ? "## User" : entry.type === "assistant" ? "## Assistant" : "## System"
    body.push(heading)
    body.push("")
    body.push(text)
    body.push("")
  })

  const out: string[] = []
  out.push("---")
  out.push(`session_id: ${meta.sessionId}`)
  out.push(`started: ${meta.startTime.toISOString()}`)
  out.push(`project: ${meta.project}`)
  out.push(`messages: ${messageCount}`)
  out.push(`source: ${meta.jsonlPath}`)
  out.push("---")
  out.push("")
  out.push(`# Session ${meta.startTime.toISOString().slice(0, 16).replace("T", " ")}`)
  out.push("")
  if (meta.firstUserText) {
    out.push(`> ${meta.firstUserText.replace(/\n/g, " ").slice(0, 160)}`)
    out.push("")
  }
  out.push(...body)
  return out.join("\n")
}

// ── commands ─────────────────────────────────────────────────────────────

function listAllJsonlPaths(): string[] {
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return []
  const paths: string[] = []
  for (const entry of readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const pdir = join(CLAUDE_PROJECTS_DIR, entry.name)
    try {
      for (const f of readdirSync(pdir)) {
        if (f.endsWith(".jsonl")) paths.push(join(pdir, f))
      }
    } catch {
      /* skip unreadable project dir */
    }
  }
  return paths
}

function findJsonlBySessionId(sessionId: string): string | undefined {
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return undefined
  // Session IDs are UUIDs. Reject anything else to prevent path traversal via
  // sessionId containing slashes or "..".
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
    return undefined
  }
  for (const entry of readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const candidate = join(CLAUDE_PROJECTS_DIR, entry.name, `${sessionId}.jsonl`)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * Ask Bun's GC to run between large per-session renders. A backfill over many
 * multi-hundred-MB transcripts in one tight sync loop never yields to the
 * event loop, so freed render strings pile up and RSS ratchets toward the
 * silvercode ACP backend RSS watchdog limit (19775). No-op outside bun.
 */
function gcNudge(): void {
  const bun = (globalThis as { Bun?: { gc?: (force: boolean) => void } }).Bun
  if (typeof bun?.gc === "function") bun.gc(false)
}

export function cmdExport(args: string[]): void {
  const force = args.includes("--force")
  const all = args.includes("--all")
  const isHook = args.includes("--hook")
  // --catchup: "export anything missing, silently".
  // Same filesystem scan as --all but:
  //   - stderr stays empty unless we actually wrote something (no spam on
  //     every SessionStart when there's nothing to do)
  //   - when combined with --hook, emits a valid empty hook response
  //   - fires a fire-and-forget `qmd update` at the end if new files were
  //     written, so the search index picks up fresh exports without the user
  //     having to remember to run `recall index`
  // This is the "system always tries to complete stuff" path: wire it into
  // SessionStart and missing-export state self-heals over time.
  const isCatchup = args.includes("--catchup")

  let jsonlPaths: string[] = []
  if (isCatchup) {
    jsonlPaths = listAllJsonlPaths()
  } else if (isHook) {
    // SessionEnd hook input shape: JSON on stdin with { session_id, ... }
    // We read it, find the matching JSONL, export it, then emit empty hook JSON.
    let raw = ""
    try {
      raw = readFileSync(0, "utf-8")
    } catch {
      /* no stdin */
    }
    let input: { session_id?: string } = {}
    try {
      input = JSON.parse(raw) as { session_id?: string }
    } catch {
      /* ignore */
    }
    const sid = input.session_id
    if (!sid) {
      // No session id — emit valid empty hook JSON and exit cleanly.
      process.stdout.write(emitHookJson("SessionEnd"))
      return
    }
    const found = findJsonlBySessionId(sid)
    if (!found) {
      process.stdout.write(emitHookJson("SessionEnd"))
      return
    }
    jsonlPaths = [found]
  } else if (all) {
    jsonlPaths = listAllJsonlPaths()
  } else {
    const positional = args.find((a) => !a.startsWith("--"))
    if (!positional) {
      process.stderr.write("usage: recall export <session-id|jsonl-path> | --all [--force] | --hook\n")
      process.exit(2)
    }
    if (positional.includes("/") || positional.endsWith(".jsonl")) {
      // Restrict explicit paths to jsonl files under ~/.claude/projects/ so
      // users can't accidentally (or be tricked into) exporting arbitrary
      // filesystem content into the configured export directory.
      const abs = resolve(positional)
      if (!abs.startsWith(CLAUDE_PROJECTS_DIR + "/") || !abs.endsWith(".jsonl")) {
        process.stderr.write(
          `recall export: path "${positional}" must be a .jsonl file under ${CLAUDE_PROJECTS_DIR}/\n`,
        )
        process.exit(1)
      }
      jsonlPaths = [abs]
    } else {
      const found = findJsonlBySessionId(positional)
      if (!found) {
        process.stderr.write(`recall export: session "${positional}" not found under ${CLAUDE_PROJECTS_DIR}\n`)
        process.exit(1)
      }
      jsonlPaths = [found]
    }
  }

  const exportDirs = resolveExportDirs(isHook)
  if (!exportDirs) {
    if (isHook) process.stdout.write(emitHookJson("SessionEnd"))
    return
  }
  const { sessionsDir, rejectedDir } = exportDirs
  if (!existsSync(sessionsDir)) mkdirSync(sessionsDir, { recursive: true })

  let written = 0
  let skipped = 0
  let empty = 0
  let rejected = 0
  for (const jsonlPath of jsonlPaths) {
    const meta = readSessionMeta(jsonlPath)
    if (!meta) {
      empty++
      continue
    }
    const filename = sessionFilename(meta)
    const outPath = join(sessionsDir, filename)
    const rejectedPath = join(rejectedDir, filename)
    // Skip existing files unless one of:
    //   --force         explicit rewrite
    //   SessionEnd hook (--hook alone, without --catchup) — we want the
    //                   freshest snapshot of the session that just ended
    // --catchup mode always skips existing files; its whole job is to backfill
    // missing exports, not rewrite ones already on disk.
    //
    // A copy in chats-rejected/ counts as existing (19775): without this,
    // every catchup re-rendered + re-quality-gated + re-rejected every
    // quarantined session forever. Rejected sessions are dominated by
    // stuck-loop monsters (hundreds of MB of jsonl each), so this was
    // ~1.3GB of re-rendering on EVERY Claude SessionStart. `--force`
    // still re-attempts a quarantined session deliberately.
    const sessionEndOverwrite = isHook && !isCatchup
    if ((existsSync(outPath) || existsSync(rejectedPath)) && !force && !sessionEndOverwrite) {
      skipped++
      continue
    }
    try {
      const md = renderSessionMarkdown(meta)
      // Quality gate: reject decayed / stuck-loop / corrupted exports BEFORE
      // they hit qmd's index. Bad docs go to chats-rejected/ with a sidecar
      // .reason so an operator can audit + restore. Reversible quarantine,
      // not deletion.
      const verdict = analyzeQuality(md)
      if (verdict.rejectReason) {
        if (!existsSync(rejectedDir)) mkdirSync(rejectedDir, { recursive: true })
        writeFileSync(rejectedPath, md, "utf-8")
        writeFileSync(
          `${rejectedPath}.reason`,
          JSON.stringify(
            {
              sessionId: meta.sessionId,
              jsonlPath,
              rejectedAt: new Date().toISOString(),
              reason: verdict.rejectReason,
              signals: verdict.signals,
            },
            null,
            2,
          ),
          "utf-8",
        )
        rejected++
        if (!all && !isHook && !isCatchup) {
          process.stderr.write(`rejected (${verdict.rejectReason}): ${rejectedPath}\n`)
        }
        gcNudge()
        continue
      }
      writeFileSync(outPath, md, "utf-8")
      written++
      if (!all && !isHook && !isCatchup) process.stderr.write(`exported: ${outPath}\n`)
      gcNudge()
    } catch (err) {
      // Don't crash the catchup / hook over one bad session — log and move on.
      process.stderr.write(`recall export: failed to write ${outPath}: ${(err as Error).message}\n`)
      empty++
    }
  }
  if (all) {
    process.stderr.write(
      `recall export: ${written} written, ${skipped} skipped (exists), ${rejected} rejected (quality gate), ${empty} unreadable (of ${jsonlPaths.length} total)\n`,
    )
    if (written > 0) {
      process.stderr.write(`run \`qmd update\` to refresh qmd's sessions collection\n`)
    }
  }
  // Catchup: stay silent unless we actually did work. When we did work, log
  // to stderr so SessionStart-hook output captures it in Claude Code's hook
  // log, and fire a background `qmd update` so the new exports become
  // searchable without user intervention.
  if (isCatchup) {
    if (written > 0) {
      process.stderr.write(`recall catchup: exported ${written} missing session(s); triggering qmd index\n`)
      // Fire-and-forget background reindex. We unref() + detach so catchup
      // returns immediately — the reindex may take seconds to minutes and
      // the user shouldn't wait on it.
      const child = spawn(QMD, ["update"], {
        stdio: "ignore",
        detached: true,
      })
      child.once("error", (error) => {
        process.stderr.write(
          `recall export: qmd update could not start: ${error.message}; run \`bun install\`, then \`qmd doctor\`\n`,
        )
      })
      child.unref()
    }
  }
  if (isHook) {
    // Claude Code's SessionEnd validator doesn't accept hookSpecificOutput
    // for this event (see emitHookJson docs). Plain {} is the correct no-op.
    process.stdout.write(emitHookJson("SessionEnd"))
  }
}

/**
 * Build a valid Claude Code hook-response JSON blob.
 *
 * Routes through `@bearly/injection-envelope`'s `emitHookJson` — the
 * canonical implementation. Re-exported here so existing callers and tests
 * that import from `./qmd-export.ts` keep working.
 *
 * Schema summary (enforced upstream):
 *   - **UserPromptSubmit** + additionalContext → full envelope
 *   - **UserPromptSubmit** with no context → plain `{}`
 *   - **SessionEnd** + anything else → plain `{}`
 */
export function emitHookJson(eventName: string, additionalContext?: string): string {
  return envelopeEmitHookJson(eventName, additionalContext)
}

function main(): void {
  const args = process.argv.slice(2)
  if (args[0] !== "export") {
    process.stderr.write(
      "[recall] qmd export adapter only supports `export`; use `recall <query>` for search or `tribe hook <event>` for hooks\n",
    )
    process.exit(2)
  }
  cmdExport(args.slice(1))
}

if (import.meta.main) main()
