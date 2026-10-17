import { describe, expect, it } from "vitest"
import { markedType, NOTIFICATION_ONLY_MARKER } from "../src/lib/notification-only.ts"

describe("markedType (29327 a settled ball is not owed work)", () => {
  it("puts a settled actionable row behind the existing notification-only marker", () => {
    expect(markedType("request", true)).toBe(`${NOTIFICATION_ONLY_MARKER}:request`)
    expect(markedType("query", true)).toBe(`${NOTIFICATION_ONLY_MARKER}:query`)
  })

  it("leaves an actionable row actionable when the row says settled false", () => {
    expect(markedType("request", false)).toBe("request")
  })

  it("leaves an actionable row actionable when the row carries no settlement flag", () => {
    expect(markedType("request")).toBe("request")
  })

  it("keeps the ambient families marked whatever the settlement flag says", () => {
    expect(markedType("status")).toBe(`${NOTIFICATION_ONLY_MARKER}:status`)
    expect(markedType("chief:note", false)).toBe(`${NOTIFICATION_ONLY_MARKER}:chief:note`)
  })
})
