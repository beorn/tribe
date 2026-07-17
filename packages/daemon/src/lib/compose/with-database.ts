/**
 * withDatabase — open the tribe SQLite database, register close on Scope.
 *
 * The DB is opened at composition time (synchronous via bun:sqlite). Closing
 * is registered on the daemon's root scope, so a clean shutdown / hot-reload
 * cleanup / test teardown closes the connection in LIFO order with the rest.
 */

import type { Database } from "bun:sqlite"
import { createLogger } from "loggily"
import { migrateLegacyTribeDbIfNeeded, withDbPathLock } from "tribe-wire/lib/config"
import { openDatabase, createStatements, type TribeStatements } from "../database.ts"
import { sweepDeadSessionRows } from "../session.ts"
import type { BaseTribe } from "./base.ts"
import type { WithConfig } from "./with-config.ts"

const log = createLogger("tribe:daemon:db")

/** Tombstones and generated placeholder identities older than this are GC'd at startup. */
const DEAD_SESSION_ROW_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export interface WithDatabase {
  readonly db: Database
  readonly stmts: TribeStatements
}

export function withDatabase<T extends BaseTribe & WithConfig>(): (t: T) => T & WithDatabase {
  return (t) => {
    const db =
      t.config.migrateLegacyDb === true
        ? withDbPathLock(t.config.dbPath, () => {
            migrateLegacyTribeDbIfNeeded(t.config.dbPath)
            return openDatabase(t.config.dbPath)
          })
        : openDatabase(t.config.dbPath)
    const swept = sweepDeadSessionRows(db, DEAD_SESSION_ROW_MAX_AGE_MS)
    if (swept > 0) log.info?.(`startup GC: swept ${swept} tombstone/generated session row(s) older than 7d`)
    const stmts = createStatements(db)
    t.scope.defer(() => {
      try {
        db.close()
      } catch {
        /* already closed */
      }
    })
    return { ...t, db, stmts }
  }
}
