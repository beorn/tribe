import { describe, expect, it } from "vitest"
import { settledMarker } from "../src/lib/settled-marker.ts"

describe("29327 settled marker", () => {
  it("names the settler on a settled row", () => {
    expect(settledMarker({ settled: true, settled_by: "@dev/brain" })).toBe("[settled by @dev/brain — not owed] ")
  })

  it("names no settler when the record has none", () => {
    expect(settledMarker({ settled: true })).toBe("[settled — not owed] ")
  })

  it("leaves an open row untouched", () => {
    expect(settledMarker({ settled: false })).toBe("")
    expect(settledMarker({})).toBe("")
  })
})
