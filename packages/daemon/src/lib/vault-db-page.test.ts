/**
 * @failure A refused recall vault pages @chief once per daemon restart (a restart loop stacks pages), or its page
 *          never clears once the file is back, or an ordinary boot pages at all.
 * @level   l2
 * @consumer 25149, @cto 405805a7: one incident page (emitter wire, subject vault-db, condition missing)
 */

import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { incidentKey } from "tribe-wire"
import { createTribeContext, type TribeContext } from "./context.ts"
import { createStatements, openDatabase } from "./database.ts"
import { pageVaultDbRefusal, VAULT_DB_INCIDENT } from "./vault-db-page.ts"

const REFUSAL = { path: "/moved/state.db", reason: "/moved/state.db does not exist (pass the vault's state.db path)" }

describe("the refused-vault page (25149)", () => {
  let dir: string
  let db: Database
  let ctx: TribeContext

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vault-db-page-"))
    db = openDatabase(join(dir, "tribe.db"))
    ctx = createTribeContext({
      db,
      stmts: createStatements(db),
      sessionId: "sess-daemon",
      sessionRole: "member",
      initialName: "daemon",
      domains: [],
      claudeSessionId: null,
      claudeSessionName: null,
    })
  })

  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const openBalls = () =>
    ctx.stmts.selectPendingSettlementsForRequest.all({ $request_id: incidentKey(VAULT_DB_INCIDENT) })
  const messageCount = () => (db.query("SELECT count(*) AS n FROM messages").get() as { n: number }).n

  it("raises one ball across refused restarts, naming the path, and clears it on a boot that finds the file", () => {
    pageVaultDbRefusal(ctx, REFUSAL)
    pageVaultDbRefusal(ctx, REFUSAL)
    expect(openBalls()).toHaveLength(1)
    const page = db.query("SELECT content FROM messages ORDER BY rowid DESC LIMIT 1").get() as { content: string }
    expect(page.content).toContain("--vault-db /moved/state.db does not exist")

    pageVaultDbRefusal(ctx, null)
    expect(openBalls()).toHaveLength(0)
  })

  it("an ordinary boot with nothing open sends nothing", () => {
    pageVaultDbRefusal(ctx, null)
    expect(messageCount()).toBe(0)
  })
})
