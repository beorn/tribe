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

describe("channel delivery has a voice (2026-09-08 — NO SILENT ERRORS)", () => {
  // sendChannel discarded every notification rejection with `.catch(() => {})`
  // on the fleet's one push path. A month of undelivered channel messages
  // therefore produced no evidence anywhere, and no seat could tell whether its
  // `delivery=push` row meant anything. Measured the same night: two seats held
  // push rows and neither ever received an envelope.
  it("has no silent catch left anywhere in the adapter", () => {
    // Comment lines are excluded on purpose: the fix's own comment quotes the
    // old `.catch(() => {})` so the next reader knows what was there, and a
    // naive substring match flags that quotation as the defect. A text guard
    // that cannot tell code from prose about code fails on its own fix.
    const codeLines = src
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => !line.startsWith("//") && !line.startsWith("*"))
    expect(codeLines.filter((line) => line.includes(".catch(() => {})"))).toEqual([])
  })

  it("gives the SUBSCRIBE call a voice — it is the push stream, not registration", () => {
    // Registration succeeding does not subscribe a session. A silently failed
    // subscribe leaves the daemon row reading delivery=push with nothing ever
    // arriving, which is the exact signature measured on two seats.
    expect(src).toContain("tribe subscribe FAILED for")
    expect(src).toContain("registered but will receive no pushed events")
  })

  it("reports a rejection with the transport named, not just that one happened", () => {
    expect(src).toContain("channel delivery REJECTED by the MCP transport")
    expect(src).toMatch(/\.catch\(\(error: unknown\) => \{/)
  })

  it("also voices the DROPS, because never-attempted is not attempted-and-failed", () => {
    // An instrument that reports only rejections cannot tell those apart: with
    // the early returns silent, zero rejections reads as "delivery works" when
    // nothing was ever sent. That ambiguity is what this pins.
    expect(src).toContain("channel delivery DROPPED before send")
    expect(src).toContain('dropChannel(label, "session has not joined")')
    expect(src).toContain('dropChannel(label, "adapter is not channel-enabled")')
  })

  it("bounds the drop reporting so one unjoined session cannot flood its own log", () => {
    expect(src).toMatch(/const channelDrops = new Map<string, number>\(\)/)
    expect(src).toMatch(/if \(seen === 1\) log\.warn/)
  })
})
