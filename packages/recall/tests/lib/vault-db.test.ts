/**
 * The one `--vault-db` rule (25149): the recall CLI, the daemon launch line and the `tribe hook` line all call
 * resolveVaultDbFlag, so its refusals are witnessed once, here.
 */
import { describe, expect, test } from "vitest"
import { resolveVaultDbFlag } from "../../src/lib/vault-db.ts"

describe("resolveVaultDbFlag", () => {
  test("absent is unbound", () => {
    expect(resolveVaultDbFlag(undefined)).toBeNull()
  })

  test.each([
    ["an empty value", ""],
    ["a blank value", "  "],
    ["a valueless flag", true],
  ] as const)("%s refuses instead of reading as unbound", (_case, raw) => {
    expect(() => resolveVaultDbFlag(raw)).toThrow(/--vault-db is empty/)
  })

  test("a present path is returned absolute, and a missing one refuses naming it", () => {
    expect(resolveVaultDbFlag("/vault/state.db", (path) => path === "/vault/state.db")).toBe("/vault/state.db")
    expect(() => resolveVaultDbFlag("/vault/state.db", () => false)).toThrow(
      "--vault-db /vault/state.db does not exist",
    )
  })
})
