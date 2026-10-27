/**
 * @failure A ball-opening row reaches the pane as its BODY, so a request
 *          settled a second after the drain composed it still opens the turn
 *          as owed work — 29327 row 5 failed exactly this way on 2026-10-18.
 * @level l3
 * @consumer 29327 row 5 — the turn-opening payload composer
 * @testonly none
 */
// 29327 row 5 (@cto 1eb4c66c) — a row that opens a ball is forwarded as the
// read directive naming its message, never as a body. The envelope is composed
// at drain time, so a body composed here can be settled a second later and
// still read as owed; the pointer cannot, because owed-ness lives in the ball
// state and the seat's own read is the receipt.
//
// The lib module is pure, so this file imports it directly. The adapter itself
// is never imported: it constructs an MCP Server and registers daemon handlers
// at load time (see stdio-adapter-instructions.test.ts).
import { describe, expect, it } from "vitest"
import {
  composeForwardedRowContent,
  WAKE_READ_DIRECTIVE_MESSAGE_ID,
  WAKE_READ_DIRECTIVE_PREFIX,
  WAKE_READ_DIRECTIVE_SHAPE,
  wakeReadDirective,
} from "../src/lib/wake-read-directive.ts"
import { markedType } from "../src/lib/notification-only.ts"
import { directiveEnvelopeMeta, escapeEnvelopeMeta } from "../src/lib/replay-cap.ts"

const ID = "1e058f4a-4721-40d6-af91-867a3ce7075f"

describe("forwarded row content", () => {
  it("a request forwards as the lean read directive with one id in the envelope attribute only (31111)", () => {
    const row = composeForwardedRowContent({ id: ID, type: "request", content: "29327 PROBE SETTLED 8d42" })
    expect(row).toEqual({ content: WAKE_READ_DIRECTIVE_PREFIX, directive: true, unnameable: false })
    expect(row.content).toBe("read your tribe inbox now")
    expect(row.content).not.toContain(ID)
    expect(row.content).not.toContain("PROBE")
    expect(WAKE_READ_DIRECTIVE_SHAPE.test(row.content)).toBe(true)
    // Pane-typed wakes without an XML envelope still form the message-named line.
    expect(WAKE_READ_DIRECTIVE_MESSAGE_ID.test(wakeReadDirective(ID))).toBe(true)
  })

  it("a row settled at drain keeps its notification-only marker", () => {
    expect(markedType("request", true)).toBe("notification-only:do-not-acknowledge-or-respond-to:request")
    expect(markedType("query", true)).toBe("notification-only:do-not-acknowledge-or-respond-to:query")
    // ...and still carries the directive, never the body it can no longer vouch for.
    expect(composeForwardedRowContent({ id: ID, type: "request", content: "owed body" }).content).toBe(
      WAKE_READ_DIRECTIVE_PREFIX,
    )
  })

  it("a notify row is unchanged", () => {
    expect(composeForwardedRowContent({ id: ID, type: "notify", content: "hello" })).toEqual({
      content: "hello",
      directive: false,
      unnameable: false,
    })
    expect(markedType("notify")).toBe("notify")
  })

  it("an id that cannot form a directive keeps its body and reports itself", () => {
    expect(composeForwardedRowContent({ id: "pending-ball:abc", type: "request", content: "body" })).toEqual({
      content: "body",
      directive: false,
      unnameable: true,
    })
  })

  it("a directive carries the sender's summary as an envelope attribute", () => {
    // Req 1: the directive carries id, sender, kind, summary and sent_at. The
    // id/sender/kind/sent_at are attributes the caller already sets; summary is
    // the value a directive row would otherwise have shown inline.
    expect(directiveEnvelopeMeta({ summary: "  ETA now  " })).toEqual({ summary: "ETA now" })
    // No summary, no attribute — a row without one stays as it was.
    expect(directiveEnvelopeMeta({ summary: "" })).toEqual({})
    expect(directiveEnvelopeMeta({})).toEqual({})
  })

  it("every sender-set meta value reaches the host unchanged, except newlines", () => {
    // @cto 51217743 GO (a): the host escapes attributes itself — Claude Code
    // 2.1.302 escapes & < > " ' in meta values, measured on probe c5bd4ebb —
    // so escaping here as well only double-escapes what the reader sees.
    // Summary, bead and topic are all sender-set and reach the host as
    // attributes; each goes through the one assembly point unchanged, and only
    // a newline is folded because an attribute cannot carry one.
    const hostile = "q\"a< b> & 'x'\nnext"
    const safe = escapeEnvelopeMeta({ summary: hostile, bead: hostile, topic: hostile })
    for (const value of Object.values(safe)) expect(value).toBe("q\"a< b> & 'x' next")
    // A value with none of those characters is byte-identical, so ordinary
    // envelopes do not change.
    expect(
      escapeEnvelopeMeta({ from: "@chief", type: "request", message_id: ID, sent_at: "2026-10-18T03:56:56.647Z" }),
    ).toEqual({
      from: "@chief",
      type: "request",
      message_id: ID,
      sent_at: "2026-10-18T03:56:56.647Z",
    })
  })
})
