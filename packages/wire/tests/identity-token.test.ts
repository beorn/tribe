/**
 * @failure A diagnostic consumer cannot read gen from the same token as sid, or exposing gen changes existing sid-only callers.
 * @level l1
 * @consumer plugins/claude/supervisor-exit-record.ts#resolveAdapterExitRecord
 * @testonly none
 */
import { describe, expect, test } from "vitest"
import { readUnverifiedTokenClaims } from "../src/lib/identity-token.ts"

const PRIVATE = "fixture-private-generation-value"
const subject = { sid: "fixture-session", act: { sub: "fixture-seat", kind: "service" } }
const legacyClaims = { sid: "fixture-session", actor: "fixture-seat", kind: "service" }

function tokenFor(gen: unknown): string {
  const payload = Buffer.from(JSON.stringify({ ...subject, gen })).toString("base64url")
  return `e30.${payload}.c2ln`
}

describe("unverified token generation opt-in (29701)", () => {
  test.each([0, 7, Number.MAX_SAFE_INTEGER])("reads generation %s only when requested", (gen) => {
    const token = tokenFor(gen)
    expect(readUnverifiedTokenClaims(token)).toEqual(legacyClaims)
    expect(readUnverifiedTokenClaims(token, { generation: true })).toEqual({ ...legacyClaims, gen })
  })

  test.each([undefined, null, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, PRIVATE, { value: PRIVATE }])(
    "a malformed generation %j stays irrelevant to old callers and is loud for the opt-in",
    (gen) => {
      const token = tokenFor(gen)
      expect(readUnverifiedTokenClaims(token)).toEqual(legacyClaims)
      let failure: unknown
      try {
        readUnverifiedTokenClaims(token, { generation: true })
      } catch (error) {
        failure = error
      }
      expect(failure).toBeInstanceOf(Error)
      expect((failure as Error).message).toMatch(/gen.*non-negative safe integer/u)
      expect((failure as Error).message).not.toContain(PRIVATE)
      expect((failure as Error).message).not.toContain(token)
    },
  )

  test("an opt-in malformed payload failure does not quote token or claim bytes", () => {
    const token = `e30.${Buffer.from(PRIVATE).toString("base64url")}.c2ln`
    expect(() => readUnverifiedTokenClaims(token)).toThrow("HAB_ID_TOKEN is malformed")
    let failure: unknown
    try {
      readUnverifiedTokenClaims(token, { generation: true })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain("HAB_ID_TOKEN is malformed")
    expect((failure as Error).message).not.toContain(PRIVATE)
    expect((failure as Error).message).not.toContain(token)
  })

  test("a null decoded payload keeps the old failure and gives the opt-in a named malformed-claims failure", () => {
    const token = `e30.${Buffer.from("null").toString("base64url")}.c2ln`
    expect(() => readUnverifiedTokenClaims(token)).toThrow(TypeError)
    expect(() => readUnverifiedTokenClaims(token, { generation: true })).toThrow("HAB_ID_TOKEN is malformed")
  })
})
