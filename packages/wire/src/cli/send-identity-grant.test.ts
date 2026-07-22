import { describe, expect, it } from "vitest"
import { classifyIdentityGrant } from "./send.ts"

// The one-shot CLI registers under the caller's session name so the daemon can
// attribute the message and close ball-tracker rows that name owns. The daemon
// refuses to let a CLI steal a name a LIVE session holds — it dedupes instead.
// Regression for 2026-07-22: @chief answered 12 balls from the CLI while its own
// seat was live; every message was delivered under a deduped `pending-*` identity
// and every tracked close reported 0 rows, so all 12 balls stayed open and looked
// unanswered. Delivered-but-not-closed must abort, never proceed quietly.

describe("classifyIdentityGrant", () => {
  it("grants when the daemon assigned exactly the requested name", () => {
    expect(classifyIdentityGrant("@chief", "@chief", true)).toEqual({ ok: true })
    expect(classifyIdentityGrant("@chief", "@chief", false)).toEqual({ ok: true })
  })

  it("is FATAL for a tracked reply when the name was deduped away", () => {
    const grant = classifyIdentityGrant("@chief", "@chief-2", true)
    expect(grant.ok).toBe(false)
    if (grant.ok) return
    expect(grant.fatal, "a tracked reply must abort, not send-and-fail-to-close").toBe(true)
    expect(grant.message).toContain("@chief-2")
    expect(grant.message).toContain("the ball is still open")
    expect(grant.message).toContain("tribe.send with the reply field")
  })

  it("is FATAL for a tracked reply when no name came back at all", () => {
    for (const assigned of [undefined, ""]) {
      const grant = classifyIdentityGrant("@chief", assigned, true)
      expect(grant.ok).toBe(false)
      if (grant.ok) continue
      expect(grant.fatal).toBe(true)
      expect(grant.message).toContain("an anonymous session")
    }
  })

  it("is a non-fatal warning for an untracked send — delivery still matters", () => {
    const grant = classifyIdentityGrant("@chief", "@chief-2", false)
    expect(grant.ok).toBe(false)
    if (grant.ok) return
    expect(grant.fatal, "an untracked send should still be delivered").toBe(false)
    expect(grant.message).toContain("attributed to")
    expect(grant.message).not.toContain("nothing was sent")
  })

  it("never reports success merely because some name came back", () => {
    const grant = classifyIdentityGrant("@ci", "@chief", false)
    expect(grant.ok).toBe(false)
  })
})
