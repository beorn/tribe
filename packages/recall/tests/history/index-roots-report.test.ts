/**
 * An index run says where it read transcripts and what it could not read (#38420, @cto 96afab5d).
 *
 * @failure  A thin index answer listed counts only, so a seat whose claude transcript sat under an ag profile home —
 *           or a root the run could not read — was invisible; "12 messages" read as the whole truth.
 * @level    l1 — pure formatting over a literal IndexResult.
 * @consumer @ag/recall/38420; every `recall index` run.
 * @reach    none
 * @testonly none
 */
import { describe, expect, test } from "vitest"
import { indexRootsReport } from "../../src/lib/index-roots-report.ts"
import type { IndexResult } from "../../src/history/indexer.ts"

const base: IndexResult = {
  files: 2,
  messages: 12,
  writes: 0,
  skippedOld: 0,
  claudeSkipped: 0,
  claudeVanished: 0,
  claudeFailures: [],
} as unknown as IndexResult

describe("index roots report", () => {
  test("names every root with its file count, and a root it did not read with the reason", () => {
    const lines = indexRootsReport({
      ...base,
      profileRootFailures: [{ provider: "claude", reason: "ag exited 1" }],
      claudeRoots: [
        {
          root: "/home/me/.claude/projects",
          readable: true,
          files: 2,
          skippedOld: 0,
          skippedUnchanged: 0,
          vanished: 0,
        },
        {
          root: "/home/me/.config/ag/profiles/claude/a/projects",
          readable: true,
          files: 7,
          skippedOld: 0,
          skippedUnchanged: 0,
          vanished: 0,
        },
        {
          root: "/home/me/.config/ag/profiles/claude/gone/projects",
          readable: false,
          reason: "missing",
          files: 0,
          skippedOld: 0,
          skippedUnchanged: 0,
          vanished: 0,
        },
      ],
      seatProfiles: {
        declared: 2,
        checked: 1,
        source: "/hh/main.hab/run/habplan.json",
        unreadable: [
          {
            seat: "@dev/9",
            provider: "claude",
            account: "gone@example.org",
            reason: "no profile named gone@example.org under /r",
          },
        ],
      },
    })

    expect(lines).toContain("  (ag did not name claude profile roots: ag exited 1)")
    expect(lines).toContain("  Claude roots: 2 read (9 files), 1 not read")
    expect(lines).toContain("    - /home/me/.claude/projects: 2 files")
    expect(lines).toContain("    - /home/me/.config/ag/profiles/claude/gone/projects: not read (missing)")
    expect(lines).toContain(
      "  Declared seats: 2 in /hh/main.hab/run/habplan.json; 1 checked against ag's profile roots, 1 without a readable profile",
    )
    expect(lines).toContain("    - @dev/9 (claude, gone@example.org): no profile named gone@example.org under /r")
  })

  test("says nothing about seats when no habitat plan was found, and names a plan it could not read", () => {
    expect(
      indexRootsReport({ ...base, seatProfiles: { declared: 0, checked: 0, source: null, unreadable: [] } }),
    ).toEqual([])

    const broken = indexRootsReport({
      ...base,
      seatProfiles: {
        declared: 0,
        checked: 0,
        source: "/p/habplan.json",
        failure: "not readable JSON: boom",
        unreadable: [],
      },
    })
    expect(broken).toEqual([
      "  (habitat plan /p/habplan.json could not be read: not readable JSON: boom; no declared seat was checked)",
    ])
  })

  test("says every checked seat is readable when none is missing, so an empty section is not silence", () => {
    const lines = indexRootsReport({
      ...base,
      seatProfiles: { declared: 3, checked: 3, source: "/p/habplan.json", unreadable: [] },
    })
    expect(lines).toEqual([
      "  Declared seats: 3 in /p/habplan.json; 3 checked against ag's profile roots, all readable",
    ])
  })

  test("says no provider profile was checked when ag named no roots, rather than claiming all readable", () => {
    const lines = indexRootsReport({
      ...base,
      profileRootFailures: [{ provider: "*", reason: "RECALL_PROFILE_ROOTS=off: ag profile roots not asked" }],
      seatProfiles: { declared: 41, checked: 0, source: "/p/habplan.json", unreadable: [] },
    })
    expect(lines).toEqual([
      "  (ag did not name * profile roots: RECALL_PROFILE_ROOTS=off: ag profile roots not asked)",
      "  Declared seats: 41 in /p/habplan.json; no provider profile was checked (see the line above for why)",
    ])
  })
})
