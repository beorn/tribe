/**
 * @ag/tribe/21768 — successor persona names must be addressable.
 *
 * Pins the class observed live 2026-07-22: a seat launched as the documented
 * successor persona `@chief/@ci/next` registered as `unknown-cmayz` and stayed
 * un-addressable for 4m17s (20:48:09Z → 20:52:26Z, pid 7440). Two independent
 * gates rejected the name — the adapter's register-time pre-seed predicate and
 * the daemon's `validateName`, which also gates `tribe.join` / `tribe.rename` —
 * so the seat could not be named at launch NOR name itself from inside.
 *
 * Both gates rejected it for the same reason: the body character class
 * `[a-z0-9_./-]` has no `@`, so the SECOND sigil in a nested role path failed.
 * `$up @role/next` is a first-class launch surface (`.claude/skills/up/SKILL.md`
 * § Successor Handoffs), so every successor rotation carried this blind window
 * by construction.
 *
 * The predicate is a path of sigil-optional segments, not a flat character bag:
 * it must accept the successor/nested forms the rest of the system emits while
 * still rejecting junk (empty, whitespace, uppercase, shell metacharacters,
 * malformed separators, over-length).
 */
import { describe, expect, it } from "vitest"
import {
  MAX_TRIBE_NAME_LENGTH,
  autoIdentifyAsk,
  isAutoName,
  isExplicitTribePersonaName,
  isTribeNameShape,
} from "../src/lib/persona-name.ts"

/**
 * Names the fleet actually emits. Every one of these must survive BOTH gates —
 * the adapter pre-seed and the daemon's join/rename validation.
 */
const ACCEPTED = [
  // The four verified live on 2026-07-22 against the pre-fix regex.
  "@ci",
  "@chief",
  "@cto",
  "@agent/7",
  // Successor handoff forms — `/up` § Successor Handoffs.
  "@ci/next",
  "@ci/prev",
  // The nested chief-owned utility role that triggered this bead. `@ci` lives
  // under `@tent/@chief.md#@ci`, so its successor path carries a second sigil.
  "@chief/@ci/next",
  "@chief/@ci/prev",
  // Shapes the old character class already allowed — kept accepted.
  "@agent/10",
  "@fleet",
  "@a.b-c_d",
] as const

/**
 * Junk that must stay rejected. The predicate exists to stop garbage
 * registering under an addressable identity; widening it to permissiveness
 * would trade one silent failure for another.
 */
const REJECTED: ReadonlyArray<readonly [name: string, why: string]> = [
  ["", "empty"],
  ["   ", "whitespace only"],
  ["@chief next", "embedded space"],
  ["@chief\tnext", "embedded tab"],
  ["@chief\nnext", "embedded newline"],
  ["@Chief", "uppercase"],
  ["@CI/next", "uppercase segment"],
  ["@chief;id", "shell metacharacter"],
  ["@chief$(whoami)", "command substitution"],
  ["@chief`id`", "backtick substitution"],
  ["@chief|tee", "pipe"],
  ["@chief&next", "ampersand"],
  ["@chief/../etc", "parent traversal segment"],
  ["@", "bare sigil, no body"],
  ["@/next", "empty first segment body"],
  ["@chief/", "trailing separator"],
  ["/chief", "leading separator"],
  ["@chief//next", "double separator"],
  ["@chief/@", "trailing bare sigil segment"],
  ["@-chief", "segment starts with a hyphen"],
  ["@.chief", "segment starts with a dot"],
  ["@chief/-next", "later segment starts with a hyphen"],
  ["@@chief", "doubled sigil inside one segment"],
  ["@ch@ief", "sigil mid-segment"],
  [`@${"a".repeat(MAX_TRIBE_NAME_LENGTH)}`, "over the length bound"],
]

describe("isExplicitTribePersonaName", () => {
  it.each(ACCEPTED)("accepts the fleet-emitted persona %s", (name) => {
    expect(isExplicitTribePersonaName(name)).toBe(true)
  })

  it.each(REJECTED)("rejects %j (%s)", (name) => {
    expect(isExplicitTribePersonaName(name)).toBe(false)
  })

  it("requires the leading sigil — an explicit persona is always @-prefixed", () => {
    // The daemon tolerates a bare name; the adapter's pre-seed does not, because
    // only a sigil-prefixed name is a persona the fleet can address.
    expect(isTribeNameShape("ci")).toBe(true)
    expect(isExplicitTribePersonaName("ci")).toBe(false)
    expect(isExplicitTribePersonaName("chief/@ci/next")).toBe(false)
  })

  it("accepts a name exactly at the length bound and rejects one past it", () => {
    const atBound = `@${"a".repeat(MAX_TRIBE_NAME_LENGTH - 1)}`
    expect(atBound).toHaveLength(MAX_TRIBE_NAME_LENGTH)
    expect(isExplicitTribePersonaName(atBound)).toBe(true)
    expect(isExplicitTribePersonaName(`${atBound}a`)).toBe(false)
  })
})

describe("isTribeNameShape", () => {
  // The daemon's join/rename validation is the second gate this bead fixes; its
  // parity assertions live next to that surface in
  // packages/daemon/src/lib/validation.test.ts.
  it.each(ACCEPTED)("accepts the sigil-prefixed persona %s", (name) => {
    expect(isTribeNameShape(name)).toBe(true)
  })

  it.each(REJECTED)("rejects %j (%s)", (name) => {
    expect(isTribeNameShape(name)).toBe(false)
  })

  it("accepts the sigil-less forms the daemon has always allowed", () => {
    expect(isTribeNameShape("ci")).toBe(true)
    expect(isTribeNameShape("agent/7")).toBe(true)
  })
})

describe("autoIdentifyAsk — the nudge must not rename a seat the fleet addresses", () => {
  // 2026-09-08. The auto-identify nudge used to fire only for auto-generated
  // names, because it was understood as a NAMING prompt. The join it asks for
  // also lifts the pre-join `pull` placeholder to the delivery mode the adapter
  // was launched with, so a seeded persona needs the join too — and now gets
  // the nudge. What it must NOT get is the naming half: measured that night,
  // six live claude seats were launched `TRIBE_DELIVERY=push` and every daemon
  // row read `pull` except the one whose model had called join by hand.

  it("offers a NAME to a session that has none", () => {
    for (const auto of ["member-1", "pending-4f2", "silvercode-3-a1b"]) {
      expect(isAutoName(auto)).toBe(true)
      expect(autoIdentifyAsk(auto)).toContain("a short name for your focus area")
    }
  })

  it("tells a seeded persona to join UNDER ITS OWN NAME, never to pick one", () => {
    for (const seat of ["@chief", "@dev/6", "@ci", "@adhoc/0"]) {
      expect(isAutoName(seat)).toBe(false)
      const ask = autoIdentifyAsk(seat)
      expect(ask).toContain(`tribe.join(name="${seat}")`)
      expect(ask).toContain("your name is already set")
      // The regression this pins: renaming @chief to a focus-area word would
      // make every seat that addresses it by name unable to reach it.
      expect(ask).not.toContain("a short name for your focus area")
    }
  })

  it("names the seat verbatim so the model does not have to derive it", () => {
    expect(autoIdentifyAsk("@dev/11")).toContain('tribe.join(name="@dev/11")')
  })
})
