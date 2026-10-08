/**
 * @failure An ask with a high-stakes option first, a duplicate label, or a
 *          type other than request/query is stored as if it were valid.
 * @level l1
 * @consumer tribe.send ask field (26520 AC1, CTO 28c0764f)
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import { deserializeAsk, parseAsk } from "./ask.ts"

describe("parseAsk", () => {
  it("accepts 1-8 unique labels and a default that is options[0]", () => {
    expect(parseAsk({ options: ["Hold", "Deploy"], default: "Hold" })).toEqual({
      ok: true,
      ask: { options: ["Hold", "Deploy"], default: "Hold" },
    })
  })

  it("trims labels", () => {
    expect(parseAsk({ options: [" Hold "] })).toEqual({ ok: true, ask: { options: ["Hold"] } })
  })

  it.each([
    [null, "tribe.send: invalid ask - must be an object {options, default?}"],
    [{ options: [] }, "tribe.send: invalid ask.options - must be an array of 1 to 8 unique non-empty labels"],
    [
      { options: ["a", "b", "c", "d", "e", "f", "g", "h", "i"] },
      "tribe.send: invalid ask.options - must be an array of 1 to 8 unique non-empty labels",
    ],
    [{ options: ["Hold", "Hold"] }, "tribe.send: invalid ask.options - labels must be unique"],
    [
      { options: [""] },
      "tribe.send: invalid ask.options[0] - each label must be a non-empty string of at most 40 characters",
    ],
    [
      { options: ["x".repeat(41)] },
      "tribe.send: invalid ask.options[0] - each label must be a non-empty string of at most 40 characters",
    ],
    [
      { options: ["Hold"], default: "Deploy" },
      "tribe.send: invalid ask.default - must be one of options and equal options[0]",
    ],
    [
      { options: ["Hold", "Deploy"], default: "Deploy" },
      "tribe.send: invalid ask.default - when set, default must equal options[0]",
    ],
    [{ options: ["Hold"], extra: true }, "tribe.send: invalid ask - unknown field extra"],
  ] as const)("refuses %j", (raw, error) => {
    expect(parseAsk(raw)).toEqual({ ok: false, error })
  })
})

describe("deserializeAsk", () => {
  it("reads null and empty as no ask so old rows stay valid", () => {
    expect(deserializeAsk(null)).toBeNull()
    expect(deserializeAsk("")).toBeNull()
  })

  it("round-trips a stored ask", () => {
    expect(deserializeAsk(JSON.stringify({ options: ["Hold"], default: "Hold" }))).toEqual({
      options: ["Hold"],
      default: "Hold",
    })
  })
})
