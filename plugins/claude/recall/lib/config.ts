/**
 * Lore configuration — path resolution for socket and DB. Pidfile plumbing
 * was deleted in Phase 5 of km-tribe.plateau — the unified tribe daemon owns
 * liveness via socket connectability (mirror of Phase 3 for tribe proper).
 */

import { existsSync, mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/** DB location: arg > TRIBE_RECALL_DB env > ~/.local/share/lore/lore.db */
export function resolveRecallDbPath(dbArg?: string): string {
  if (dbArg) return dbArg
  const fromEnv = process.env.TRIBE_RECALL_DB
  if (fromEnv) return fromEnv
  const xdgData = process.env.XDG_DATA_HOME ?? resolve(process.env.HOME ?? "~", ".local/share")
  const loreDir = resolve(xdgData, "lore")
  if (!existsSync(loreDir)) mkdirSync(loreDir, { recursive: true })
  return resolve(loreDir, "lore.db")
}

/** Ensure parent directory for a file path exists */
export function ensureParentDir(path: string): void {
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}
