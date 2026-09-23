import { Database } from "bun:sqlite"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import {
  CURRENT_SCHEMA_VERSION,
  MIGRATION_STEPS,
  initSchema,
  runMigrations,
  type MigrationStep,
} from "../../src/history/db-schema"

describe("Migration versioning (A6)", () => {
  let db: Database

  beforeEach(() => {
    db = new Database(":memory:")
  })

  afterEach(() => {
    db.close()
  })

  test("initSchema initializes schema and advances user_version to CURRENT_SCHEMA_VERSION", () => {
    initSchema(db)
    const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version
    expect(version).toBe(CURRENT_SCHEMA_VERSION)
  })

  test("second runMigrations at CURRENT_SCHEMA_VERSION runs no migration steps", () => {
    initSchema(db)
    const versionBefore = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version
    expect(versionBefore).toBe(CURRENT_SCHEMA_VERSION)

    // Trace statements on a second run
    let executedStatements = 0
    // Spy on db.exec
    const originalExec = db.exec.bind(db)
    db.exec = ((sql: string) => {
      executedStatements++
      return originalExec(sql)
    }) as any

    runMigrations(db)

    // db.exec should not have been called at all because user_version is already current
    expect(executedStatements).toBe(0)
  })

  test("forced migration failure throws and names itself", () => {
    // Construct a failing migration step
    const badStep: MigrationStep = {
      version: 999,
      name: "forced-failure-step",
      up: () => {
        throw new Error("intentional syntax error or disk failure")
      },
    }

    MIGRATION_STEPS.push(badStep)
    try {
      expect(() => initSchema(db)).toThrow(/\[migration v999\] forced-failure-step failed/)
    } finally {
      const idx = MIGRATION_STEPS.indexOf(badStep)
      if (idx !== -1) {
        MIGRATION_STEPS.splice(idx, 1)
      }
    }
  })
})
