/**
 * The one `--vault-db` rule (25149): the recall CLI, the daemon launch line and the `tribe hook` line all call
 * resolveVaultDbFlag, so its refusals are witnessed once, here.
 */
import { describe, expect, test } from "vitest"
import { classifyVaultDbFlag, resolveVaultDbFlag } from "../../src/lib/vault-db.ts"

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

  // The daemon maps a missing file to a refused vault instead of an exit (@cto 405805a7); the rule classifies it.
  test("classify returns a missing file as refused, naming it; an empty flag still throws", () => {
    expect(classifyVaultDbFlag(undefined)).toEqual({ state: "unbound" })
    expect(classifyVaultDbFlag("/vault/state.db", () => true)).toEqual({ state: "bound", path: "/vault/state.db" })
    expect(classifyVaultDbFlag("/vault/state.db", () => false)).toEqual({
      state: "refused",
      path: "/vault/state.db",
      reason: "/vault/state.db does not exist (pass the vault's state.db path)",
    })
    expect(() => classifyVaultDbFlag("")).toThrow(/--vault-db is empty/)
  })
})
