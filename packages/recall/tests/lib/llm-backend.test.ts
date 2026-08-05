import { describe, test, expect } from "vitest"
import { parseDeniedProviders, withProviderDenyList } from "../../src/lib/llm-backend"

// ============================================================================
// parseDeniedProviders
// ============================================================================

describe("parseDeniedProviders", () => {
  test("returns an empty set for undefined input", () => {
    expect(parseDeniedProviders(undefined).size).toBe(0)
  })

  test("returns an empty set for blank/whitespace input", () => {
    expect(parseDeniedProviders("").size).toBe(0)
    expect(parseDeniedProviders("   ").size).toBe(0)
  })

  test("splits a comma-separated list, trims, and lowercases", () => {
    const denied = parseDeniedProviders(" OpenAI , xai ,openai")
    expect([...denied].sort()).toEqual(["openai", "xai"])
  })

  test("drops empty entries from stray commas", () => {
    const denied = parseDeniedProviders("openai,,xai,")
    expect([...denied].sort()).toEqual(["openai", "xai"])
  })

  test("single provider", () => {
    expect([...parseDeniedProviders("openrouter")]).toEqual(["openrouter"])
  })
})

// ============================================================================
// withProviderDenyList
// ============================================================================

describe("withProviderDenyList", () => {
  test("returns the original function unchanged (identity) when the deny set is empty", () => {
    const raw = (provider: string) => provider === "openrouter"
    const wrapped = withProviderDenyList(raw, parseDeniedProviders(undefined))
    expect(wrapped).toBe(raw)
  })

  test("denied providers read as unavailable even when the raw check says available", () => {
    const raw = () => true // every provider "has a key"
    const wrapped = withProviderDenyList(raw, parseDeniedProviders("openai,xai"))
    expect(wrapped("openai")).toBe(false)
    expect(wrapped("xai")).toBe(false)
    expect(wrapped("openrouter")).toBe(true)
  })

  test("denial is case-insensitive on the provider argument", () => {
    const raw = () => true
    const wrapped = withProviderDenyList(raw, parseDeniedProviders("openai"))
    expect(wrapped("OpenAI")).toBe(false)
  })

  test("a non-denied provider still defers to the raw availability check (key presence)", () => {
    const raw = (provider: string) => provider === "openrouter"
    const wrapped = withProviderDenyList(raw, parseDeniedProviders("openai"))
    expect(wrapped("openrouter")).toBe(true)
    expect(wrapped("xai")).toBe(false) // not denied, but raw says no key either
  })
})
