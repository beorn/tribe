/**
 * 25149 (d): the vault binding is a process-level fact, so the recall CLI takes it as a LEADING global
 * `--vault-db <path>`, stripped before the search-prepend routing and bound through bindVaultDb; every verb then
 * routes as before. `search`'s own `--vault-db` is gone (one spelling), and the refusals are the one
 * resolveVaultDbFlag rule the daemon and the hook line also call (@cto 18703529).
 *
 * The verbs are mocked so each records what vault was bound when it ran; the binding itself is real.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const calls: { verb: string; arg: unknown; opts: Record<string, unknown>; vault: string | null }[] = []

vi.mock("../src/lib/search", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/lib/search")>()
  const { getVaultDbPath } = await import("../src/history/vault-fts.ts")
  return {
    ...orig,
    cmdSearch: async (query: string, opts: Record<string, unknown>) => {
      calls.push({ verb: "search", arg: query, opts, vault: getVaultDbPath() })
    },
  }
})

vi.mock("../src/lib/summarize-daily", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/lib/summarize-daily")>()
  const { getVaultDbPath } = await import("../src/history/vault-fts.ts")
  return {
    ...orig,
    cmdSummarize: async (date: string | undefined, opts: Record<string, unknown>) => {
      calls.push({ verb: "summarize", arg: date, opts, vault: getVaultDbPath() })
    },
  }
})

const { main } = await import("../src/cli.ts")
const { resetVaultDbCacheForTests } = await import("../src/history/vault-fts.ts")

let dir: string
let vault: string
let previousVaultDb: string | undefined
let errSpy: ReturnType<typeof vi.spyOn>
let exitSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "recall-cli-vault-"))
  vault = join(dir, "state.db")
  new Database(vault).close()
  previousVaultDb = process.env.KM_VAULT_DB
  delete process.env.KM_VAULT_DB
  resetVaultDbCacheForTests()
  calls.length = 0
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`)
  }) as typeof process.exit)
})

afterEach(() => {
  errSpy.mockRestore()
  exitSpy.mockRestore()
  resetVaultDbCacheForTests()
  if (previousVaultDb === undefined) delete process.env.KM_VAULT_DB
  else process.env.KM_VAULT_DB = previousVaultDb
  rmSync(dir, { recursive: true, force: true })
})

const errText = () => errSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n")

describe("recall --vault-db <path> <verb>: a leading global binding (25149 d)", () => {
  test("binds a subcommand: `recall --vault-db X summarize` runs summarize with X bound", async () => {
    await main(["--vault-db", vault, "summarize"])
    expect(calls).toEqual([expect.objectContaining({ verb: "summarize", vault })])
  })

  test("the --vault-db=X spelling binds the same way", async () => {
    await main([`--vault-db=${vault}`, "summarize"])
    expect(calls).toEqual([expect.objectContaining({ verb: "summarize", vault })])
  })

  test("binds the default search: `recall --vault-db X foo bar` searches for 'foo bar' with X bound", async () => {
    await main(["--vault-db", vault, "foo bar"])
    expect(calls).toEqual([expect.objectContaining({ verb: "search", arg: "foo bar", vault })])
  })

  test("binds agent mode through the same flag: `recall --vault-db X --agent q`", async () => {
    await main(["--vault-db", vault, "--agent", "q"])
    expect(calls).toEqual([expect.objectContaining({ verb: "search", arg: "q", vault })])
    expect(calls[0]?.opts.agent).toBe(true)
  })

  test("no flag runs unbound, and a verb that reads no vault says nothing about it", async () => {
    await main(["summarize"])
    expect(calls).toEqual([expect.objectContaining({ verb: "summarize", vault: null })])
    expect(errText()).not.toMatch(/vault/i)
  })

  test.each([
    ["a valueless flag", ["--vault-db"], /--vault-db is empty/],
    ["an empty value (a failed substitution)", ["--vault-db", "", "summarize"], /--vault-db is empty/],
    [
      "a missing path",
      ["--vault-db", "/missing/state.db", "summarize"],
      /--vault-db \/missing\/state\.db does not exist/,
    ],
  ] as const)(
    "%s refuses with exit 2 (a usage error) naming the fault, and no verb runs",
    async (_case, argv, fault) => {
      await expect(main([...argv])).rejects.toThrow("process.exit(2)")
      expect(errText()).toMatch(fault)
      expect(calls).toEqual([])
    },
  )

  test("one spelling: search no longer takes its own --vault-db", async () => {
    await expect(main(["search", "q", "--vault-db", vault])).rejects.toThrow("process.exit(2)")
    expect(errText()).toMatch(/unknown option '--vault-db'/)
    expect(calls).toEqual([])
  })
})
