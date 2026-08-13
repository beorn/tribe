/**
 * `getSessionsByProviderLaunchId` matched derived launch ids with
 * `substr(launch_id, 1, length($p)) = $p`, a function applied to the indexed
 * column. SQLite cannot use an index for that, so every managed-inbox request
 * scanned the whole `sessions` table — a cost that grew with exactly the row
 * count the register/die leak was inflating.
 *
 * The replacement is a half-open range. These tests pin the two things that
 * have to hold: it selects the same rows as the predicate it replaces, and the
 * planner actually uses an index for it (an equivalent query that still scans
 * would pass a rows-returned assertion while fixing nothing).
 */
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { createTribeContext } from "./context.ts"
import { readAttentionProjection } from "./handlers.ts"
import { derivedLaunchPrefixUpperBound } from "./launch-prefix-range.ts"

describe("derivedLaunchPrefixUpperBound", () => {
  it("bounds a prefix above without excluding any string that has it", () => {
    const upper = derivedLaunchPrefixUpperBound("launch-1::") as string
    expect(upper).toBe("launch-1:;")
    // Plain comparisons: the range must hold for the string ordering SQLite's
    // BINARY collation uses, not for numeric matchers.
    expect("launch-1::" >= "launch-1::").toBe(true)
    expect("launch-1::anything" < upper).toBe(true)
    expect("launch-1::\u{10FFFF}" < upper).toBe(true)
  })

  it("refuses an empty prefix rather than returning a bound that means nothing", () => {
    // An empty prefix matches every row, so no range can express it. Returning
    // a bound here would quietly produce a query that matches nothing.
    expect(derivedLaunchPrefixUpperBound("")).toBeNull()
  })

  it("still bounds a prefix ending at the top of the code point range", () => {
    const upper = derivedLaunchPrefixUpperBound("x\u{10FFFF}")
    expect(upper).not.toBeNull()
    expect("x\u{10FFFF}" < (upper as string)).toBe(true)
  })
})

/**
 * `filterRowsByTrust` now materialises the roster only when a row actually
 * carries a registered trust topic. That is a change on a SECURITY path: if the
 * short-circuit were too broad, a row that should be trust-filtered would be
 * admitted unchecked. These pin both directions — the skip must apply only to
 * topics the trust rules do not govern, and a governed topic must still be
 * filtered exactly as before.
 */
describe("trust filtering after the roster short-circuit", () => {
  let tmpDir: string
  let db: Database
  let stmts: TribeStatements

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "trust-shortcircuit-"))
    db = openDatabase(join(tmpDir, "tribe.db"))
    stmts = createStatements(db)
    // Only "@rostered" is a registered member. "@stranger" never joined.
    db.prepare(
      "INSERT INTO sessions (id, name, role, domains, pid, cwd, project_id, started_at, updated_at) " +
        "VALUES ('s1', '@rostered', 'member', '[]', 1, '/repo', 'p', 0, 0)",
    ).run()
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function seed(id: string, sender: string, topic: string | null): void {
    db.prepare(
      "INSERT INTO messages (id, type, sender, recipient, kind, content, ts, delivery, topic, attention_required) " +
        "VALUES ($id, 'request', $sender, '@reader', 'direct', 'x', 0, 'pull', $topic, 1)",
    ).run({ $id: id, $sender: sender, $topic: topic })
  }

  function admittedSenders(): string[] {
    const ctx = createTribeContext({
      db,
      stmts,
      sessionId: "reader",
      sessionRole: "member",
      initialName: "@reader",
      domains: [],
      claudeSessionId: null,
      claudeSessionName: null,
    })
    return readAttentionProjection(ctx, "@reader").attentionRows.map((row) => row.sender)
  }

  it("still filters an unrostered sender off a registered trust topic", () => {
    // "bead:*" is an internal-tier registered topic, so the roster decides.
    seed("m1", "@stranger", "bead:22873")
    expect(admittedSenders()).toEqual([])
  })

  it("still admits a rostered sender on the same registered trust topic", () => {
    seed("m1", "@rostered", "bead:22873")
    expect(admittedSenders()).toEqual(["@rostered"])
  })

  it("admits an ungoverned topic from any sender, which is what the skip covers", () => {
    seed("m1", "@stranger", "chat")
    seed("m2", "@stranger", null)
    expect(admittedSenders().sort()).toEqual(["@stranger", "@stranger"])
  })

  it("filters the governed row even when ungoverned rows share the batch", () => {
    // The short-circuit is per-BATCH, so one governed row must pull the whole
    // batch through the roster filter rather than the batch skipping it.
    seed("m1", "@stranger", "chat")
    seed("m2", "@stranger", "bead:22873")
    expect(admittedSenders()).toEqual(["@stranger"])
  })
})

describe("getSessionsByProviderLaunchId", () => {
  let tmpDir: string
  let db: Database
  let stmts: TribeStatements

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "launch-prefix-range-"))
    db = openDatabase(join(tmpDir, "tribe.db"))
    stmts = createStatements(db)
    const insert = db.prepare(
      "INSERT INTO sessions (id, name, role, domains, pid, cwd, project_id, started_at, updated_at, launch_id, launch_parent_pid) " +
        "VALUES ($id, $name, 'member', '[]', 1, '/repo', 'p', 0, 0, $launch_id, 1)",
    )
    const rows: Array<[string, string, string | null]> = [
      ["s1", "exact", "launch-1"],
      ["s2", "derived-a", "launch-1::adapter-a"],
      ["s3", "derived-b", "launch-1::adapter-b"],
      ["s4", "other-launch", "launch-2"],
      ["s5", "other-derived", "launch-2::adapter-a"],
      // A launch id that shares a textual prefix but is NOT a derived child:
      // it must not be swept in by the range.
      ["s6", "prefix-lookalike", "launch-10"],
      ["s7", "null-launch", null],
    ]
    for (const [id, name, launchId] of rows) insert.run({ $id: id, $name: name, $launch_id: launchId })
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function queryFor(launchId: string): string[] {
    const prefix = `${launchId}::`
    const rows = stmts.getSessionsByProviderLaunchId.all({
      $launch_id: launchId,
      $derived_prefix: prefix,
      $derived_prefix_upper: derivedLaunchPrefixUpperBound(prefix),
    }) as Array<{ name: string }>
    return rows.map((row) => row.name)
  }

  it("returns the exact launch row and its derived children, and nothing else", () => {
    expect(queryFor("launch-1").sort()).toEqual(["derived-a", "derived-b", "exact"])
  })

  it("does not sweep in a launch id that merely shares a textual prefix", () => {
    // "launch-10" starts with "launch-1" but is a different launch. Only the
    // "launch-1::" separator marks a derived child.
    expect(queryFor("launch-1")).not.toContain("prefix-lookalike")
  })

  it("agrees exactly with the substr predicate it replaced", () => {
    const legacy = db
      .prepare(
        "SELECT name FROM sessions WHERE launch_id = $launch_id " +
          "OR substr(launch_id, 1, length($derived_prefix)) = $derived_prefix ORDER BY id",
      )
      .all({ $launch_id: "launch-1", $derived_prefix: "launch-1::" }) as Array<{ name: string }>
    expect(queryFor("launch-1")).toEqual(legacy.map((row) => row.name))
  })

  it("uses an index instead of scanning the sessions table", () => {
    const plan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT name, launch_id, launch_parent_pid FROM sessions " +
          "WHERE launch_id = $launch_id " +
          "OR (launch_id >= $derived_prefix AND launch_id < $derived_prefix_upper) ORDER BY id",
      )
      .all({
        $launch_id: "launch-1",
        $derived_prefix: "launch-1::",
        $derived_prefix_upper: derivedLaunchPrefixUpperBound("launch-1::"),
      }) as Array<{ detail: string }>
    const detail = plan.map((row) => row.detail).join(" | ")

    // The whole point of the change: no full-table scan of `sessions`.
    expect(detail).not.toMatch(/SCAN sessions(?! USING)/)
    expect(detail).toMatch(/idx_sessions_launch_id/)
  })
})
