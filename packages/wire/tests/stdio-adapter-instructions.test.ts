// Guards the turn-start inbox instruction against context-flood regressions.
//
// km @km/tribe/19442-turn-start-fetch-context-flood: the MCP server instructions
// told every chief/member/pull session to call `tribe.fetch({ limit: 50 })` on
// EVERY user turn. New messages already arrive inline as <channel> envelopes, so
// the 50-event window re-pulled already-seen ambient traffic each turn and burned
// long-running agent context. The fix routes all role variants through one shared
// `turnStartInboxCheck` constant and caps the turn-start drain at 10. Delivery
// capability variants live in one helper so channel/host-stream/pull wording can
// differ without reintroducing role-level drift.
//
// This is a grep-guard: it reads the adapter SOURCE as text and never imports the
// module (the adapter constructs an MCP Server + registers daemon handlers at load
// time, so importing it has side effects we don't want in a unit test).
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src/stdio-adapter.ts")
const src = readFileSync(SRC, "utf8")

describe("turn-start inbox instruction (km 19442 context-flood guard)", () => {
  it("defines the turn-start guidance through one shared delivery helper", () => {
    expect((src.match(/const turnStartInboxCheck\b/g) ?? []).length).toBe(1)
    expect((src.match(/function turnStartInboxCheckForDelivery\b/g) ?? []).length).toBe(1)
    // one literal per delivery mode: channel, host-stream, and pull
    expect((src.match(/Turn-start inbox check:/g) ?? []).length).toBe(3)
  })

  it("shares that one block across all three role variants (chief/member/pull)", () => {
    expect((src.match(/\$\{turnStartInboxCheck\}/g) ?? []).length).toBe(3)
  })

  it("makes the attention projection the shared turn-start view", () => {
    expect((src.match(/const attentionProjectionInstruction\b/g) ?? []).length).toBe(1)
    expect(src).toContain("attention.actionable_unread")
    expect(src).toContain("attention.pending_balls")
    expect((src.match(/\$\{attentionProjectionInstruction\}/g) ?? []).length).toBe(3)
  })

  it("no longer tells sessions to replay a 50-event window every turn", () => {
    expect(src).not.toContain("At the start of each user turn, call tribe.fetch({ limit: 50 })")
    expect(src).not.toMatch(/tribe\.fetch\(\{ limit: 50 \}\)/)
  })

  it("caps every turn-start fetch instruction at <= 10", () => {
    // Instruction-form fetches only: `tribe.fetch({ ... limit: N ... })`.
    // The delivery-path drain `daemon?.call("tribe.fetch", { limit: 500 })` uses a
    // different call syntax and is intentionally NOT model guidance — it must not
    // match this pattern (regression canary: if it ever did, 500 would fail here).
    const limits = [...src.matchAll(/tribe\.fetch\(\{[^}]*limit:\s*(\d+)[^}]*\}\)/g)].map((m) => Number(m[1]))
    expect(limits.length).toBeGreaterThan(0)
    expect(Math.max(...limits)).toBeLessThanOrEqual(10)
  })

  it("preserves direct-message discoverability + snapshot-filter freshness", () => {
    // The `with:` / `from:` snapshot filters stay documented so peers remain
    // discoverable, and the "newest matching" intent is spelled out.
    expect(src).toMatch(/with: <your session name>/)
    expect(src).toMatch(/from: <peer>/)
    expect(src).toMatch(/newest matching/)
  })

  it("points idle-wait policy at delivery capability metadata instead of hardcoded fetch loops", () => {
    expect(src).toContain("TRIBE_PULL_TRANSPORT")
    expect(src).toContain("const deliveryInstruction = deliveryCapabilityInstruction(DELIVERY_CAPABILITY)")
    expect(src).not.toContain("native Codex should use CLI")
    expect(src).not.toContain("Silver UI/Silvercode")
  })
})

describe("auto-identify nudge fires on NOT-JOINED, not on the name (2026-09-08)", () => {
  // A managed seat is launched with its persona name seeded, so it never
  // surfaces as unknown-* and the old isAutoName gate never fired for it.
  // Nothing else in this process asks a model to join, and until it joins
  // registerParamsForConnection reports pull however push-capable the adapter
  // is. Six live claude seats measured that night: all launched
  // TRIBE_DELIVERY=push, every daemon row pull but one.
  it("gates the nudge on the join state, never on the name shape", () => {
    expect(src).toMatch(/if \(!nudgeSent && !joined\)/)
    expect(src).not.toMatch(/if \(!nudgeSent && isAutoName\(/)
  })

  it("keeps the once-only semantics — only the second conjunct changed", () => {
    expect((src.match(/nudgeSent = true/g) ?? []).length).toBe(1)
    expect((src.match(/let nudgeSent = false/g) ?? []).length).toBe(1)
  })

  it("reads join-ness from the adapter's existing flag, with no second authority", () => {
    expect((src.match(/^let joined = /m) ?? []).length).toBe(1)
    expect(src).toContain('if (name === "join") joined = true')
  })

  it("delegates the wording so a seeded persona is never told to rename", () => {
    // The branch itself is behaviourally tested in persona-name.test.ts; the
    // adapter must not carry a second copy of that decision.
    expect(src).toContain("autoIdentifyAsk(myName)")
    expect(src).not.toMatch(/isAutoName\(myName\)\s*\n?\s*\?/)
  })

  it("tells the model to OMIT delivery, so the join activates the launched mode", () => {
    // Passing delivery SETS the value instead of activating what the 21919
    // classifier already decided at launch, which is both wrong and the thing
    // that would invalidate any measurement of the promotion.
    expect(src).toContain("Omit the delivery parameter")
  })
})
