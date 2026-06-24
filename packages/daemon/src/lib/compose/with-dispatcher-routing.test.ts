import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

describe("socket dispatcher coordination method routing", () => {
  it("routes tribe.repair through the normal tool-call dispatcher", () => {
    const source = readFileSync(new URL("./with-dispatcher.ts", import.meta.url), "utf8")

    expect(source).toContain("case TRIBE_COORD_METHODS.repair:")
  })
})
