/**
 * Vendor-local runtime identity helpers (@km/infra/20359). `formatRuntimeId` is
 * the pure core (`<version>+<sha>`, never a fabricated sha); `tribeWireRuntimeId`
 * composes the wire package version with a live git read.
 */

import { describe, expect, it } from "vitest"
import { formatRuntimeId, tribeWireRuntimeId, wireVersion } from "../src/runtime-id.ts"

describe("formatRuntimeId", () => {
  it("composes `<version>+<sha>`", () => {
    expect(formatRuntimeId("0.1.4", "abc1234")).toBe("0.1.4+abc1234")
  })
  it("null sha → +unknown (loud, never a fabricated sha)", () => {
    expect(formatRuntimeId("0.1.4", null)).toBe("0.1.4+unknown")
  })
})

describe("wireVersion", () => {
  it("reads a real semver from the wire package.json", () => {
    expect(wireVersion()).toMatch(/^\d+\.\d+\.\d+/)
  })
})

describe("tribeWireRuntimeId", () => {
  it("is `<semver>+<sha-or-unknown>` shaped", () => {
    expect(tribeWireRuntimeId()).toMatch(/^\d+\.\d+\.\d+.*\+(?:[0-9a-f]+|unknown)$/)
  })
})
