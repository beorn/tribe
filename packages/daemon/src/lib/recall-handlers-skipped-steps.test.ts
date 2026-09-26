/**
 * The daemon's `tribe.inject_delta` returns the step it skipped rather than waited on.
 *
 * @failure A busy project-source step inside the daemon was caught and recorded nowhere: the handler passed no
 *          record and returned no skip, so a daemon-served prompt logged "daemon ok" (@ag/tribe/25071 row 3 review).
 * @level     l2 — the real handler and the real in-repo engine; project sources, search and the glossary are
 *            mocked at their modules, so no index, vault or socket is touched.
 */
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { safeRemoveSync } from "removely"
import { afterAll, describe, expect, test, vi } from "vitest"
import { TRIBE_METHODS, type InjectDeltaResult } from "../../../../plugins/claude/recall/lib/rpc.ts"
import { createRecallHandlers } from "./recall-handlers.ts"

const SKIPPED_MSG = "recall messages capped: test"
const fake = vi.hoisted(() => ({ results: [] as unknown[] }))

vi.mock("../../../recall/src/history/search.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../recall/src/history/search.ts")>()),
  recall: async () => ({
    results: fake.results,
    skipped: [{ phase: "messages", anchor: "test", message: SKIPPED_MSG }],
  }),
}))
// A bound vault, so the first injection is not the unbound-vault notice (25149 a1): this suite asks about the
// skipped step, and the notice's own carriage of it is pinned in inject-core's tests.
vi.mock("../../../recall/src/history/vault-fts.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../recall/src/history/vault-fts.ts")>()),
  getVaultDbPath: () => "/bound/vault.db",
}))
vi.mock("../../../recall/src/history/vault-glossary.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../recall/src/history/vault-glossary.ts")>()),
  findGlossaryAnchor: () => null,
}))

const base = mkdtempSync(join(realpathSync(tmpdir()), "recall-handlers-skip-"))
afterAll(() => safeRemoveSync(base, { within: realpathSync(tmpdir()) }))

describe("tribe.inject_delta carries a skipped step", () => {
  test.each([
    ["no hits, so the prompt is skipped", [], true],
    [
      "one hit, so the prompt is injected",
      [
        {
          sessionId: "sess-abcd1234",
          sessionTitle: "sess-title",
          type: "message",
          snippet: "A descriptive snippet that is plenty long enough to pass the minimum filter.",
          rank: -10,
          timestamp: Date.now(),
        },
      ],
      false,
    ],
  ])("%s: the result names the skipped recall phase", async (_case, results, skipped) => {
    fake.results = results
    const handlers = createRecallHandlers({
      dbPath: join(base, `lore-${String(skipped)}.db`),
      socketPath: join(base, "lore.sock"),
      daemonVersion: "test",
    })
    try {
      const result = (await handlers.dispatch(
        { sessionId: `s-${String(skipped)}`, claudePid: null },
        TRIBE_METHODS.injectDelta,
        {
          prompt: "what did we decide about km-storage-sync layering?",
        },
      )) as InjectDeltaResult
      expect(result.skipped).toBe(skipped)
      expect(result.skippedSteps).toEqual({ "recall.messages": SKIPPED_MSG })
    } finally {
      await handlers.close()
    }
  })
})
