/**
 * @failure The claim auto-rename swallows the daemon's refusal, so a seat stays on its generated name with no trace
 *          that a claim asked to rename it and was rejected.
 * @level l1
 * @consumer stdio-adapter claim auto-rename (34204, carried from @cto fa0336bf)
 * @testonly none
 *
 * A refusal - a rejected call, an error answer, an answer with no name, or an unparseable answer - is reported at
 * warn with both identities: the scope asked for and the name the seat still holds. An accepted rename reports the
 * daemon's name and no warning. The rename is attempted at most once.
 */
import { describe, expect, it } from "vitest"
import { createClaimAutoRename, type ClaimAutoRenameOptions } from "../src/lib/claim-auto-rename.ts"

const SESSION = "0f3c9a1b-2d4e-4f60-8a91-b2c3d4e5f601"
const CLAIM = "Claimed: km-storage.foo - the store claims it [by:claude:0f3c9a1b]"

function harness(overrides: Partial<ClaimAutoRenameOptions> = {}) {
  const warnings: string[] = []
  const renamed: string[] = []
  const asked: string[] = []
  let marked = 0
  let done = false
  const run = createClaimAutoRename({
    currentName: () => "km-4-x7q",
    sessionId: () => SESSION,
    rename: async (scope) => {
      asked.push(scope)
      return { name: scope }
    },
    onRenamed: (name) => renamed.push(name),
    warn: (message) => warnings.push(message),
    renamed: () => done,
    markRenamed: () => {
      done = true
      marked += 1
    },
    ...overrides,
  })
  return { run, warnings, renamed, asked, marked: () => marked }
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe("claim auto-rename (34204)", () => {
  it("reports a rejected rename with the scope asked for, the name the seat holds, and the daemon's words", async () => {
    const h = harness({
      rename: async () => {
        throw new Error('tribe.rename refused: requested "km-storage", verified "km-4-x7q"')
      },
    })
    h.run(CLAIM)
    await settle()
    expect(h.renamed).toEqual([])
    expect(h.warnings).toHaveLength(1)
    expect(h.warnings[0]).toContain('requested "km-storage"')
    expect(h.warnings[0]).toContain('verified "km-4-x7q"')
    expect(h.warnings[0]).toContain("refused")
  })

  it("reports an error answer the same way instead of reading it as success", async () => {
    const h = harness({ rename: async () => ({ error: 'Name "km-storage" is already taken' }) })
    h.run(CLAIM)
    await settle()
    expect(h.renamed).toEqual([])
    expect(h.warnings).toHaveLength(1)
    expect(h.warnings[0]).toContain('requested "km-storage"')
    expect(h.warnings[0]).toContain('verified "km-4-x7q"')
    expect(h.warnings[0]).toContain("already taken")
  })

  it("reports an answer with no name instead of counting the rename as applied", async () => {
    const h = harness({ rename: async () => ({}) })
    h.run(CLAIM)
    await settle()
    expect(h.renamed).toEqual([])
    expect(h.warnings).toEqual([expect.stringContaining('requested "km-storage"')])
  })

  it("reports the daemon's name on success and keeps quiet", async () => {
    const h = harness()
    h.run(CLAIM)
    await settle()
    expect(h.asked).toEqual(["km-storage"])
    expect(h.renamed).toEqual(["km-storage"])
    expect(h.warnings).toEqual([])
  })

  it("attempts the rename once, even when a later claim row arrives", async () => {
    const h = harness()
    h.run(CLAIM)
    h.run(CLAIM)
    await settle()
    expect(h.asked).toEqual(["km-storage"])
    expect(h.marked()).toBe(1)
  })

  it("does nothing when the session is already renamed, names another session, or already holds the scope", async () => {
    const alreadyRenamed = harness({ renamed: () => true })
    alreadyRenamed.run(CLAIM)
    const another = harness({ sessionId: () => "ffffffff-0000-0000-0000-000000000000" })
    another.run(CLAIM)
    const sameScope = harness({ currentName: () => "km-storage" })
    sameScope.run(CLAIM)
    const explicitName = harness({ currentName: () => "@dev/1" })
    explicitName.run(CLAIM)
    const noMarker = harness()
    noMarker.run("Claimed: km-storage.foo - no marker here")
    await settle()
    for (const h of [alreadyRenamed, another, sameScope, explicitName, noMarker]) {
      expect(h.asked).toEqual([])
      expect(h.warnings).toEqual([])
      expect(h.renamed).toEqual([])
    }
  })
})
