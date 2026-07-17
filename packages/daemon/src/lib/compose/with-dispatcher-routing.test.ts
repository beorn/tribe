import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { shouldDeliver } from "./with-broadcast.ts"

describe("socket dispatcher coordination method routing", () => {
  it("routes tribe.repair through the normal tool-call dispatcher", () => {
    const source = readFileSync(new URL("./with-dispatcher.ts", import.meta.url), "utf8")

    expect(source).toContain("case TRIBE_COORD_METHODS.repair:")
  })
})

describe("focus-mode notification diet", () => {
  const focus = { filter_mode: "focus", filter_until: null, filter_mute: null }

  it.each([
    { type: "session", topic: null },
    { type: "status", topic: null },
    { type: "delta", topic: null },
    { type: "chief:heartbeat", topic: "chief:heartbeat" },
    { type: "github:push", topic: "github:push" },
    { type: "notify", topic: "github:workflow:success" },
    { type: "notify", topic: "git:commit" },
  ])("keeps $type/$topic pull-only for opted-in seats even when direct", ({ type, topic }) => {
    expect(shouldDeliver({ kind: "direct", type, topic, replyHint: "yes" }, focus)).toBe(false)
  })

  it.each(["request", "query", "assign", "verdict"])("still pushes direct %s actionables", (type) => {
    expect(shouldDeliver({ kind: "direct", type, topic: null, replyHint: "yes" }, focus)).toBe(true)
  })

  it.each(["notify", "response", "ball:reminder"])(
    "keeps plain or retired direct %s pull-only while focus mode is active",
    (type) => {
      expect(shouldDeliver({ kind: "direct", type, topic: null, replyHint: "yes" }, focus)).toBe(false)
    },
  )

  it("leaves direct notification delivery unchanged until a seat opts in", () => {
    expect(
      shouldDeliver(
        { kind: "direct", type: "github:push", topic: "github:push", replyHint: "yes" },
        { filter_mode: "normal", filter_until: null, filter_mute: null },
      ),
    ).toBe(true)
  })
})
