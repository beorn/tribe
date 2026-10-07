/**
 * Tribe DB location and its migration lock — the only home of `@bearly/flock` in the
 * wire config surface.
 *
 * 27941: kept apart from `config-light` because neither bridge half takes the lock (only
 * the daemon and `tribe send` resolve a DB path), so the supervisor and adapter child stop
 * paying flock's ~2.8 MB at startup. `lib/config` re-exports these names, so the daemon and
 * CLI importers are unchanged.
 */

import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { acquireFlockBlocking } from "@bearly/flock"
import { findBeadsDir } from "./beads-path.ts"
import type { TribeArgs } from "./config-light.ts"

export type ResolveDbPathOptions = {
  /** Defer legacy migration so a caller can hold the lock through DB creation. */
  migrateLegacy?: boolean
}

/**
 * DB location. Priority:
 *   1. `--db` flag
 *   2. `TRIBE_DB` env var
 *   3. User-global `~/.local/share/tribe/tribe.db` (new default, matches
 *      the socket at `~/.local/share/tribe/tribe.sock`)
 *   4. Legacy `.beads/tribe.db` — if present and step 3 doesn't exist, migrate
 *      it forward by moving the files to the XDG path. This unblocks retiring
 *      `.beads/` in projects that moved off bd for issue tracking.
 *
 * See km-tribe.decouple-db-location. Pre-0.11.2 the priority order was
 * `--db > TRIBE_DB > .beads/tribe.db > XDG`, which conflated tribe with bd:
 * a repo couldn't delete `.beads/` without taking tribe down with it.
 */
export function resolveDbPath(args: TribeArgs, options: ResolveDbPathOptions = {}): string {
  if (args.db) return String(args.db)
  if (process.env.TRIBE_DB) return process.env.TRIBE_DB

  const xdgData = process.env.XDG_DATA_HOME ?? resolve(process.env.HOME ?? "~", ".local/share")
  const tribeDir = resolve(xdgData, "tribe")
  const xdgDbPath = resolve(tribeDir, "tribe.db")

  mkdirSync(tribeDir, { recursive: true })
  if (options.migrateLegacy !== false) {
    return withDbPathLock(xdgDbPath, () => {
      migrateLegacyTribeDbIfNeeded(xdgDbPath)
      return xdgDbPath
    })
  }
  return xdgDbPath
}

/**
 * Hold the process-shared migration lock for one DB-path operation.
 *
 * The daemon uses this around both migration and `new Database(create:true)`.
 * A resolver that sees a legacy DB therefore cannot rename over a fresh DB
 * created by another startup between the existence check and rename.
 */
export function withDbPathLock<Result>(dbPath: string, operation: () => Result): Result {
  mkdirSync(dirname(dbPath), { recursive: true })
  const lockPath = `${dbPath}.migration.lock`
  using _lock = acquireFlockBlocking(lockPath)
  return operation()
}

/** Re-check and migrate the legacy DB while the caller holds the DB-path lock. */
export function migrateLegacyTribeDbIfNeeded(xdgDbPath: string, from?: string): void {
  if (existsSync(xdgDbPath)) return
  const beadsDir = findBeadsDir(from)
  if (!beadsDir) return
  const legacyDb = resolve(beadsDir, "tribe.db")
  if (!existsSync(legacyDb)) return
  migrateLegacyTribeDb(legacyDb, xdgDbPath)
}

/**
 * Move a legacy `.beads/tribe.db` (+ its WAL/SHM sidecars) to the XDG path.
 * Best-effort: if rename fails (e.g. cross-device), fall through and let the
 * caller fall back to creating a fresh DB at the XDG location.
 */
function migrateLegacyTribeDb(legacyPath: string, xdgPath: string): void {
  try {
    renameSync(legacyPath, xdgPath)
    // Sidecars may or may not exist — best-effort.
    for (const suffix of ["-wal", "-shm"]) {
      const src = `${legacyPath}${suffix}`
      if (existsSync(src)) {
        try {
          renameSync(src, `${xdgPath}${suffix}`)
        } catch {
          // silent-fallback-allow: a WAL/SHM sidecar that will not move is rebuilt by SQLite; the DB itself already moved.
          /* leave it — SQLite will rebuild the sidecar */
        }
      }
    }
    // Drop a breadcrumb so users discovering the old path understand.
    try {
      writeFileSync(
        `${legacyPath}.moved`,
        `Moved to ${xdgPath} on ${new Date().toISOString()} — see km-tribe.decouple-db-location.\n`,
        "utf-8",
      )
    } catch {
      // silent-fallback-allow: the breadcrumb is a courtesy note for someone who finds the old path; losing it must not fail a migration that already succeeded.
      /* best-effort */
    }
  } catch {
    // silent-fallback-allow: a cross-device or permission-blocked migration leaves the legacy DB untouched and the caller opens a fresh XDG DB.
    /* cross-device or perms — leave the legacy DB in place; caller opens a fresh XDG DB. */
  }
}
