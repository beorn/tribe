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
  wakeReadDirective,
} from "../src/lib/wake-read-directive.ts"
import { markedType } from "../src/lib/notification-only.ts"
import { directiveEnvelopeMeta } from "../src/lib/replay-cap.ts"

const ID = "1e058f4a-4721-40d6-af91-867a3ce7075f"

describe("forwarded row content", () => {
  it("a request forwards as a read directive naming its message, with no body", () => {
    const row = composeForwardedRowContent({ id: ID, type: "request", content: "29327 PROBE SETTLED 8d42" })
    expect(row).toEqual({ content: wakeReadDirective(ID), directive: true, unnameable: false })
    expect(row.content).toBe(`read your tribe inbox now: ${ID}`)
    expect(row.content).not.toContain("PROBE")
    // The line the wire forms is the line a pane accepts.
    expect(WAKE_READ_DIRECTIVE_MESSAGE_ID.test(row.content)).toBe(true)
  })

  it("a row settled at drain keeps its notification-only marker", () => {
    expect(markedType("request", true)).toBe("notification-only:do-not-acknowledge-or-respond-to:request")
    expect(markedType("query", true)).toBe("notification-only:do-not-acknowledge-or-respond-to:query")
    // ...and still carries the directive, never the body it can no longer vouch for.
    expect(composeForwardedRowContent({ id: ID, type: "request", content: "owed body" }).content).toBe(
      wakeReadDirective(ID),
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

  it("a directive carries the sender's summary as an escaped envelope attribute", () => {
    // Req 1: the directive carries id, sender, kind, summary and sent_at. The
    // id/sender/kind/sent_at are attributes the caller already sets; summary is
    // the one free-text value, so it is escaped for the attribute context.
    expect(directiveEnvelopeMeta({ summary: 'ETA "now" <b>' })).toEqual({ summary: "ETA &quot;now&quot; &lt;b&gt;" })
    expect(directiveEnvelopeMeta({ summary: "line one\nline two" })).toEqual({ summary: "line one line two" })
    // No summary, no attribute — a row without one stays as it was.
    expect(directiveEnvelopeMeta({ summary: "" })).toEqual({})
    expect(directiveEnvelopeMeta({})).toEqual({})
  })
})
