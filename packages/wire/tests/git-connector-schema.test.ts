/**
 * @failure Hab publishes a schema digest that differs from the one a typed Git fact declares, or accepts an empty declared source.
 * @level l1
 * @consumer Hab's connector publisher, Wire's Git plugin and Km's local schema-bundle reader.
 * @testonly none
 */
import { createHash } from "node:crypto"
import { describeGitConnector } from "../src/lib/git-connector-schema.ts"
import { describe, expect, it } from "vitest"

const source = {
  logicalSourceId: "code",
  contractVersion: "git.commit.v1",
  bindings: [{ id: "main", checkout: "/code" }],
  selectedRefs: ["refs/heads/*"],
  start: { kind: "baseline-now" },
  decoder: { version: "1", trailers: { binds: ["Binds"], refs: ["Refs"], closes: ["Resolves"] } },
}

describe("Git connector describe", () => {
  it("returns one schema digest matching its JSON Schema bytes for the declared source", () => {
    const described = describeGitConnector({ version: 1, sources: [source] })
    const entry = described.sources.code
    expect(entry).toBeDefined()
    expect(entry!.digest).toBe(createHash("sha256").update(JSON.stringify(entry!.schema)).digest("hex"))
    expect(described.settings.sources[0]?.logicalSourceId).toBe("code")
  })

  it("refuses a declared connector without a source instead of publishing an empty bundle", () => {
    expect(() => describeGitConnector({ version: 1, sources: [] })).toThrow()
  })

  it("refuses ref patterns the observer cannot interpret and duplicate physical binding ids", () => {
    expect(() =>
      describeGitConnector({ version: 1, sources: [{ ...source, selectedRefs: ["refs/heads/feature*extra"] }] }),
    ).toThrow()
    expect(() =>
      describeGitConnector({
        version: 1,
        sources: [{ ...source, bindings: [...source.bindings, { id: "main", checkout: "/other" }] }],
      }),
    ).toThrow()
  })

  it("refuses extra authored fields instead of silently dropping them", () => {
    expect(() =>
      describeGitConnector({ version: 1, sources: [{ ...source, selectedRef: "refs/heads/main" }] }),
    ).toThrow(/selectedRef/u)
    expect(() =>
      describeGitConnector({
        version: 1,
        sources: [{ ...source, bindings: [{ ...source.bindings[0], comment: "ignored" }] }],
      }),
    ).toThrow(/comment/u)
  })
})
