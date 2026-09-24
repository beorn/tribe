/**
 * The daemon's recall searches the vault its launch line names, and says so when it names none.
 *
 * @failure The daemon ran recall in-process with only the KM_VAULT_DB it happened to inherit from the seat that
 *          started its supervisor, so a restart from any other environment searched no vault (25149 a3).
 * @level     l2 — the real handlers and the real in-repo engine and vault binding; project sources, search and the
 *            glossary are mocked at their modules, so no index or socket is touched.
 */
import { Database } from "bun:sqlite"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { safeRemoveSync } from "removely"
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest"
import { TRIBE_METHODS, type InjectDeltaResult } from "../../../../plugins/claude/recall/lib/rpc.ts"
import { VAULT_UNBOUND_NOTICE } from "../../../recall/src/lib/inject-core.ts"
import { getVaultDbPath } from "../../../recall/src/history/vault-fts.ts"
import { createRecallHandlers } from "./recall-handlers.ts"

vi.mock("../../../recall/src/history/project-sources.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../recall/src/history/project-sources.ts")>()),
  ensureProjectSourcesIndexed: () => undefined,
}))
vi.mock("../../../recall/src/history/search.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../recall/src/history/search.ts")>()),
  recall: async () => ({ results: [] }),
}))
vi.mock("../../../recall/src/history/vault-glossary.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../recall/src/history/vault-glossary.ts")>()),
  findGlossaryAnchor: () => null,
}))

const base = mkdtempSync(join(realpathSync(tmpdir()), "recall-handlers-vault-"))
const vaultDb = join(base, "state.db")
const inheritedVault = process.env.KM_VAULT_DB

beforeAll(() => {
  // Only the launch line may bind: the runner's own environment must not.
  delete process.env.KM_VAULT_DB
  new Database(vaultDb, { create: true }).close()
})
afterAll(() => {
  if (inheritedVault !== undefined) process.env.KM_VAULT_DB = inheritedVault
  safeRemoveSync(base, { within: realpathSync(tmpdir()) })
})

async function injectOnce(name: string, vaultDbPath: string | null): Promise<InjectDeltaResult> {
  const handlers = createRecallHandlers({
    dbPath: join(base, `lore-${name}.db`),
    socketPath: join(base, "lore.sock"),
    daemonVersion: "test",
    vaultDbPath,
  })
  try {
    return (await handlers.dispatch({ sessionId: `s-${name}`, claudePid: null }, TRIBE_METHODS.injectDelta, {
      prompt: "what did we decide about km-storage-sync layering?",
    })) as InjectDeltaResult
  } finally {
    await handlers.close()
  }
}

// Order matters: recall's vault binding is process-wide, so the unbound case runs before anything binds.
describe("the daemon binds --vault-db into recall (25149 a3)", () => {
  test("a daemon launched without --vault-db says the vault is not bound", async () => {
    const result = await injectOnce("unbound", null)
    expect(getVaultDbPath()).toBeNull()
    expect(result.additionalContext).toContain(VAULT_UNBOUND_NOTICE)
  })

  test("a daemon launched with --vault-db searches that vault, and the notice is gone", async () => {
    const result = await injectOnce("bound", vaultDb)
    expect(getVaultDbPath()).toBe(vaultDb)
    expect(result.additionalContext ?? "").not.toContain(VAULT_UNBOUND_NOTICE)
  })
})
