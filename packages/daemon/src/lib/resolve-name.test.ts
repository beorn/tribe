/**
 * @failure resolve-name.ts documents an eight-layer adoption fallback its body
 *          never implemented; a reader then believes a registering session can
 *          adopt a prior name or role inside resolveName (it cannot — adoption
 *          is decided in compose/with-dispatcher.ts before the call).
 * @level l0
 * @consumer the register path in compose/with-dispatcher.ts (@ag/hab/29762)
 * @testonly none
 */
import { describe, expect, it } from "vitest"

import { isUnidentifiedSessionName, resolveName } from "./resolve-name.ts"

const none = new Set<string>()

function resolve(p: Record<string, unknown>, claudeSessionName: string | null, taken = none): string {
  return resolveName({ p, claudeSessionName, takenNames: taken })
}

describe("resolveName", () => {
  it("returns an explicit name verbatim, including a hat-shaped one", () => {
    expect(resolve({ name: "@dev/7" }, null)).toBe("@dev/7")
    expect(resolve({ name: "chief" }, null)).toBe("chief")
    expect(resolve({ name: "codex-bjorn" }, null)).toBe("codex-bjorn")
  })

  it("auto-numbers a flavor default to the lowest free slot among connected names", () => {
    expect(resolve({ name: "codex-12345-67890" }, null)).toBe("codex1")
    expect(resolve({ name: "codex-12345-67890" }, null, new Set(["codex1"]))).toBe("codex2")
    expect(resolve({ name: "codex" }, null, new Set(["codex1", "codex2"]))).toBe("codex3")
  })

  it("takes claudeSessionName when p.name is absent", () => {
    expect(resolve({}, "@agent/79")).toBe("@agent/79")
  })

  it("falls back to a non-hat-shaped unknown-<rand> placeholder, never agent<N>", () => {
    const name = resolve({}, null)
    expect(isUnidentifiedSessionName(name)).toBe(true)
    expect(name).toMatch(/^unknown-[a-z0-9]{5}$/u)
  })
})
