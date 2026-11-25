/**
 * A seat launched through ag keeps its claude transcript under a provider profile home, and recall must read it
 * (#38420).
 *
 * @failure  Recall indexed the stock ~/.claude only, so every claude transcript written under
 *           ~/.config/ag/profiles/claude/<account>/projects was invisible to search — a hosted seat's own words
 *           returned nothing, and a thin answer never said which roots it had read.
 * @level    l2 — a temp stock home, a temp ag profile home with a real transcript, and a temp on-disk index; the ag
 *           answer is supplied, so the test spawns nothing.
 * @consumer @ag/recall/38420; every `recall` search and index run.
 * @reach    fs-walk <fixture-only: walks this test's mkdtempSync roots>
 * @testonly none
 */
import { Database } from "bun:sqlite"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { safeRemoveSync } from "removely"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

process.env.RECALL_DB_PATH = ":memory:"

const { refreshIndexForQuery, reportQueryRefresh } = await import("../../src/history/query-refresh.ts")
const { claudeProjectDirs, readDeclaredSeats, checkDeclaredSeats } = await import("../../src/history/profile-roots.ts")
const { initSchema } = await import("../../src/history/db.ts")

const TOKEN = "hosted_seat_phrase_4b19"
let root: string
let claudeDir: string
let profileHome: string
let db: Database
let previousClaudeDir: string | undefined
let stderrSpy: ReturnType<typeof vi.spyOn>

const stderr = () => stderrSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("")

function transcript(dir: string, project: string, sessionId: string, text: string): string {
  const at = join(dir, project)
  mkdirSync(at, { recursive: true })
  const file = join(at, `${sessionId}.jsonl`)
  writeFileSync(
    file,
    JSON.stringify({
      sessionId,
      type: "user",
      timestamp: "2026-11-25T07:37:00.000Z",
      message: { role: "user", content: `${TOKEN} ${text}` },
    }) + "\n",
    "utf8",
  )
  return file
}

const found = () =>
  (db.prepare("SELECT COUNT(*) AS c FROM messages WHERE content LIKE ?").get(`%${TOKEN}%`) as { c: number }).c

beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "recall-profile-roots-"))
  claudeDir = join(root, "claude")
  profileHome = join(root, "profiles", "claude", "seat@example.org")
  mkdirSync(join(claudeDir, "projects"), { recursive: true })
  mkdirSync(profileHome, { recursive: true })
  previousClaudeDir = process.env.CLAUDE_DIR
  process.env.CLAUDE_DIR = claudeDir
  db = new Database(join(root, "index.db"))
  initSchema(db)
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
})

afterEach(() => {
  if (previousClaudeDir === undefined) delete process.env.CLAUDE_DIR
  else process.env.CLAUDE_DIR = previousClaudeDir
  db.close()
  vi.restoreAllMocks()
  safeRemoveSync(root, { within: realpathSync(tmpdir()) })
})

const rootsOf = (...profiles: string[]) => ({
  roots: [
    {
      provider: "claude",
      root: join(root, "profiles", "claude"),
      exists: true,
      profiles: profiles.map((dir) => ({ name: "seat@example.org", dir, authenticated: true })),
    },
  ],
  failures: [],
})

describe("ag profile roots are transcript roots (38420)", () => {
  test("a transcript under a profile home is indexed, so the seat's own phrase is found", async () => {
    transcript(join(profileHome, "projects"), "-hh", "hosted-session", "the retro alarm cleared")
    expect(found()).toBe(0)

    const receipt = await refreshIndexForQuery(db, { capMs: 5_000, profileRoots: rootsOf(profileHome) })

    expect(receipt).toMatchObject({ indexed: 1, notSearched: 0 })
    expect(found()).toBe(1)
    const roots = receipt.roots ?? []
    expect(roots.map((entry) => entry.root)).toEqual([join(claudeDir, "projects"), join(profileHome, "projects")])
    expect(roots.every((entry) => entry.readable)).toBe(true)
  })

  test("the roots are named every run, including one with nothing new", async () => {
    transcript(join(profileHome, "projects"), "-hh", "hosted-session", "body")
    reportQueryRefresh(await refreshIndexForQuery(db, { capMs: 5_000, profileRoots: rootsOf(profileHome) }))
    expect(stderr()).toContain("claude roots:")
    expect(stderr()).toContain(join(profileHome, "projects"))
  })

  test("a profile root that is missing is named with its reason instead of skipped", async () => {
    const missing = join(root, "profiles", "claude", "gone@example.org")
    const receipt = await refreshIndexForQuery(db, { capMs: 5_000, profileRoots: rootsOf(missing) })
    const entry = (receipt.roots ?? []).find((one) => one.root === join(missing, "projects"))
    expect(entry).toMatchObject({ readable: false, reason: "missing" })

    reportQueryRefresh(receipt)
    expect(stderr()).toContain("missing")
  })

  test("a provider root ag could not name is reported, not silently dropped", async () => {
    const receipt = await refreshIndexForQuery(db, {
      capMs: 5_000,
      profileRoots: { roots: rootsOf(profileHome).roots, failures: [{ provider: "claude", reason: "ag exited 1" }] },
    })
    expect(receipt.roots).toEqual(expect.arrayContaining([expect.objectContaining({ reason: "ag exited 1" })]))
  })

  test("claudeProjectDirs maps every claude profile home to its projects dir and nothing else", () => {
    const dirs = claudeProjectDirs({
      roots: [
        {
          provider: "claude",
          root: "/r/claude",
          exists: true,
          profiles: [{ name: "a", dir: "/r/claude/a", authenticated: true }],
        },
        {
          provider: "codex",
          root: "/r/codex",
          exists: true,
          profiles: [{ name: "b", dir: "/r/codex/b", authenticated: true }],
        },
      ],
      failures: [],
    })
    expect(dirs).toEqual([join("/r/claude/a", "projects")])
  })

  test("a declared seat with no readable profile is named, with the reason it cannot be read", () => {
    const plan = join(root, "habplan.json")
    writeFileSync(
      plan,
      JSON.stringify({
        habitants: [
          { argv: ["ag", "code", "--name", "@dev/9", "--harness", "claude", "--account", "gone@example.org"] },
          { argv: ["ag", "code", "--name", "@dev/3", "--harness", "claude", "--account", "seat@example.org"] },
          { argv: ["ag", "code", "--name", "@agy/1", "--harness", "agy", "--account", "someone@example.org"] },
          { argv: ["ahpd", "serve"] },
        ],
      }),
      "utf8",
    )

    const declared = readDeclaredSeats({ RECALL_HAB_PLAN: plan })
    expect(declared.source).toBe(plan)
    expect(declared.seats.map((seat) => seat.name)).toEqual(["@dev/9", "@dev/3", "@agy/1"])

    const checked = checkDeclaredSeats(declared.seats, rootsOf(profileHome))
    // @agy/1 keeps no profile home under ag, so it is not called unreadable; the claude seats are both checked.
    expect(checked.checked).toBe(2)
    expect(checked.unreadable).toEqual([
      {
        seat: "@dev/9",
        provider: "claude",
        account: "gone@example.org",
        reason: `no profile named gone@example.org under ${join(root, "profiles", "claude")}`,
      },
    ])
  })

  test("an unreadable habitat plan is a named failure, not an empty seat list", () => {
    const plan = join(root, "broken-habplan.json")
    writeFileSync(plan, "{ not json", "utf8")
    const declared = readDeclaredSeats({ RECALL_HAB_PLAN: plan })
    expect(declared.source).toBe(plan)
    expect(declared.failure).toContain("not readable JSON")
    expect(declared.seats).toEqual([])
  })
})
