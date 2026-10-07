/**
 * Tribe configuration WITHOUT a filesystem probe: CLI args, env vars, roles, and
 * session/project identity.
 *
 * 27941: `lib/config` used to be one module, so both halves of every tribe bridge —
 * the supervisor and its adapter child — paid `@bearly/flock` (2.8 MB) and `removely`
 * (2.1 MB) at startup through it, though the supervisor locks nothing and the adapter
 * never probes `.beads/`. This module is the part of that surface with NO flock and NO
 * removely in its graph; the path probes moved to `beads-path` (removely) and `db-path`
 * (flock). `lib/config` remains a barrel that re-exports all three, so every existing
 * `tribe-wire/lib/config` import keeps working — it just keeps paying for the parts it
 * never uses.
 */

import type { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { realpathSync } from "node:fs"
import { parseArgs } from "node:util"
import {
  BD_ACTOR_ENV,
  CLAUDE_SESSION_ID_ENV,
  CLAUDE_SESSION_NAME_ENV,
  TRIBE_ACCOUNT_ENV,
  TRIBE_DOMAINS_ENV,
  TRIBE_NAME_ENV,
  TRIBE_PROVIDER_ENV,
  TRIBE_ROLE_ENV,
} from "../launch-environment.ts"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Session lifecycle tag — a typed marker on the session (stored in
 * `sessions.role`) describing the *connection lifecycle*, NOT a coordination
 * role. There is no chief/member distinction at L2: the tribe-wire daemon is
 * role-agnostic and delivers every message type to every session. Chief-ness
 * is an L3 fact (the `@chief` bead lease) the daemon neither knows nor cares
 * about — see F12 of @km/tribe/15496-coordination-drift.
 *
 *   - "daemon"  — the daemon itself; not a participating session.
 *   - "member"  — a regular worker session. Default for newly-joined sessions.
 *   - "watch"   — a dashboard / observer (e.g. `tribe watch`); receives every
 *                 message on its wire regardless of recipient.
 *   - "pending" — half-registered placeholder used between socket accept and
 *                 the client's first `register` call.
 */
export type TribeRole = "daemon" | "member" | "watch" | "pending"

/** Subset of roles that participate as regular tribe members. */
export type TribeParticipantRole = "member"

export const TRIBE_ROLES: readonly TribeRole[] = ["daemon", "member", "watch", "pending"] as const

export function isValidRole(r: unknown): r is TribeRole {
  return typeof r === "string" && (TRIBE_ROLES as readonly string[]).includes(r)
}

export type TribeConfig = {
  name: string
  role: TribeRole
  domains: string[]
  dbPath: string
  beadsDir: string | null
  autoReport: boolean
  claudeSessionId: string | null
  claudeSessionName: string | null
  sessionId: string
}

export type TribeArgs = {
  name?: string
  role?: string
  domains?: string
  db?: string
  socket?: string
  "auto-report"?: boolean
  /**
   * @km/infra/15641 Phase 1 — per-session account label. `ag` sets
   * `TRIBE_ACCOUNT` when launching backends; the adapter forwards it
   * in registration so `tribe.members` can show "which account is
   * each session on?". Tribe doesn't poll quotas — that lives in `ag`.
   */
  account?: string
  /** Companion to `account` — the provider (claude, codex, etc.). */
  provider?: string
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export function parseTribeArgs(): TribeArgs {
  const { values } = parseArgs({
    options: {
      name: { type: "string", default: process.env[TRIBE_NAME_ENV] },
      role: { type: "string", default: process.env[TRIBE_ROLE_ENV] },
      domains: { type: "string", default: process.env[TRIBE_DOMAINS_ENV] ?? "" },
      db: { type: "string", default: process.env.TRIBE_DB },
      socket: { type: "string", default: process.env.TRIBE_SOCKET },
      "auto-report": { type: "boolean", default: (process.env.TRIBE_AUTO_REPORT ?? "1") === "1" },
      // @km/infra/15641 Phase 1 — account/provider label, sourced from
      // ag via TRIBE_ACCOUNT / TRIBE_PROVIDER env vars at spawn time.
      account: { type: "string", default: process.env[TRIBE_ACCOUNT_ENV] },
      provider: { type: "string", default: process.env[TRIBE_PROVIDER_ENV] },
    },
    strict: false,
  })
  return values as TribeArgs
}

export function parseSessionDomains(args: TribeArgs): string[] {
  return String(args.domains ?? "")
    .split(",")
    .filter(Boolean)
}

/** Resolve the connection-lifecycle tag for a registering session.
 *  There is no chief/member auto-detection — every working session is a plain
 *  "member". "watch" and "daemon" are always passed explicitly. */
export function detectRole(_db: Database, args: TribeArgs): TribeRole {
  if (args.role && isValidRole(args.role)) return args.role
  return "member"
}

/** Auto-generate name: members get "member-<N>" */
export function detectName(db: Database, _role: TribeRole, args: TribeArgs): string {
  if (args.name) return String(args.name)
  // Use PID-based name to avoid race conditions (max+1 can collide)
  const pidName = `member-${process.pid}`
  const taken = db.prepare("SELECT id FROM sessions WHERE name = ?").get(pidName)
  if (!taken) return pidName
  // PID collision (unlikely) — fall back to random suffix
  return `member-${process.pid}-${Math.random().toString(36).slice(2, 5)}`
}

/** Resolve the Claude Code session ID from env vars */
export function resolveClaudeSessionId(): string | null {
  return process.env[CLAUDE_SESSION_ID_ENV] ?? process.env[BD_ACTOR_ENV]?.replace("claude:", "") ?? null
}

export function resolveClaudeSessionName(): string | null {
  return process.env[CLAUDE_SESSION_NAME_ENV] ?? null
}

/** Canonical project identity — deterministic hash of the resolved project root path.
 *  Handles symlinks, worktrees, and avoids collisions (two repos both named "api"). */
export function resolveProjectId(cwd?: string): string {
  const dir = cwd ?? process.cwd()
  try {
    const real = realpathSync(dir)
    return createHash("sha256").update(real).digest("hex").slice(0, 12)
  } catch {
    return createHash("sha256").update(dir).digest("hex").slice(0, 12)
  }
}
