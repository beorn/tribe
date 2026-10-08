/**
 * @reach fs-walk <fixture-only: export streaming scans temporary session trees>
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest"
import { mkdtempSync, writeFileSync, rmSync, appendFileSync, mkdirSync, readdirSync, statSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { RECORD_BYTE_LIMIT, forEachJsonlLine, readSessionMeta, renderSessionMarkdown } from "../src/qmd-export.ts"

// 19775 (@km/silvercode/19775-claude-resume-rss-runaway): `recall export
// --catchup --hook` runs on every Claude SessionStart and used to
// readFileSync + split("\n") EVERY session jsonl under ~/.claude/projects
// (4.3GB / 1445 files on the reporting machine) just to derive the export
// filename for the skip-existing check. In a tight sync loop Bun RSS
// ballooned to ~7GB, tripping Silver Code's ACP backend RSS watchdog and
// killing the session shortly after `--resume`. The fix streams jsonl
// line-by-line with a bounded buffer and stops the meta scan as soon as
// every meta field is known. These tests pin (a) the streaming reader's
// contract, (b) meta/render semantic equivalence with the old whole-file
// reader, and (c) the memory bound itself.

// 27785: the reader's 256 KiB read chunk bounded the READ but not the RECORD —
// `carry` grew until a newline, so one long record was still an unbounded
// allocation. This is the reviewed finite raw-record budget (4 MiB excluding
// the newline, the value CTO approved for the shared reader in
// hub/tribe/research/27702-bounded-summary-architecture.md:143). The source
// must export it under the same value, and enforce it on every call.
const REVIEWED_RECORD_LIMIT_BYTES = 4 * 1024 * 1024

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "qmd-export-streaming-"))
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

function entryLine(fields: Record<string, unknown>): string {
  return JSON.stringify(fields)
}

function userEntry(text: string, extra: Record<string, unknown> = {}): string {
  return entryLine({
    type: "user",
    sessionId: "11111111-2222-3333-4444-555555555555",
    timestamp: "2026-06-01T10:00:00.000Z",
    cwd: "/Users/test/project",
    message: { role: "user", content: [{ type: "text", text }] },
    ...extra,
  })
}

function assistantEntry(text: string, extra: Record<string, unknown> = {}): string {
  return entryLine({
    type: "assistant",
    sessionId: "11111111-2222-3333-4444-555555555555",
    timestamp: "2026-06-01T10:00:05.000Z",
    cwd: "/Users/test/project",
    message: { role: "assistant", content: [{ type: "text", text }] },
    ...extra,
  })
}

describe("forEachJsonlLine", () => {
  test("yields every non-blank line and skips blank lines", () => {
    const p = join(dir, "basic.jsonl")
    writeFileSync(p, '{"a":1}\n\n{"b":2}\n   \n{"c":3}\n', "utf-8")
    const seen: string[] = []
    forEachJsonlLine(p, (line) => {
      seen.push(line)
    })
    expect(seen).toEqual(['{"a":1}', '{"b":2}', '{"c":3}'])
  })

  test("returning false stops the scan early", () => {
    const p = join(dir, "early-stop.jsonl")
    const lines = Array.from({ length: 50_000 }, (_, i) => `{"i":${i}}`)
    writeFileSync(p, lines.join("\n") + "\n", "utf-8")
    let calls = 0
    forEachJsonlLine(p, () => {
      calls++
      return calls >= 3 ? false : undefined
    })
    expect(calls).toBe(3)
  })

  test("handles a final line without trailing newline", () => {
    const p = join(dir, "no-trailing.jsonl")
    writeFileSync(p, '{"a":1}\n{"b":2}', "utf-8")
    const seen: string[] = []
    forEachJsonlLine(p, (line) => {
      seen.push(line)
    })
    expect(seen).toEqual(['{"a":1}', '{"b":2}'])
  })

  test("multibyte UTF-8 survives chunk boundaries", () => {
    // Lines sized so 4-byte emoji and 3-byte CJK straddle the 256KB read
    // boundary somewhere in the file regardless of alignment.
    const p = join(dir, "multibyte.jsonl")
    const payload = "héllo🤖世界".repeat(40)
    const line = JSON.stringify({ text: payload })
    const count = Math.ceil((512 * 1024) / (line.length + 1))
    writeFileSync(p, Array.from({ length: count }, () => line).join("\n") + "\n", "utf-8")
    let bad = 0
    let total = 0
    forEachJsonlLine(p, (l) => {
      total++
      if (l.includes("�")) bad++
      if ((JSON.parse(l) as { text: string }).text !== payload) bad++
    })
    expect(total).toBe(count)
    expect(bad).toBe(0)
  })
})

describe("readSessionMeta (streaming)", () => {
  test("extracts the same meta the whole-file reader produced", () => {
    const p = join(dir, "meta.jsonl")
    writeFileSync(
      p,
      [
        entryLine({ type: "summary", summary: "irrelevant" }),
        userEntry("fix the failing test in storage"),
        assistantEntry("on it"),
      ].join("\n") + "\n",
      "utf-8",
    )
    const meta = readSessionMeta(p)
    expect(meta).toBeDefined()
    expect(meta?.sessionId).toBe("11111111-2222-3333-4444-555555555555")
    expect(meta?.startTime.toISOString()).toBe("2026-06-01T10:00:00.000Z")
    expect(meta?.project).toBe("/Users/test/project")
    expect(meta?.firstUserText).toBe("fix the failing test in storage")
  })

  test("skips synthetic user turns when picking firstUserText", () => {
    const p = join(dir, "synthetic.jsonl")
    writeFileSync(
      p,
      [userEntry("<system-reminder>noise</system-reminder>"), userEntry("[tool result]"), userEntry("real ask")].join(
        "\n",
      ) + "\n",
      "utf-8",
    )
    expect(readSessionMeta(p)?.firstUserText).toBe("real ask")
  })

  test("returns undefined for an empty file", () => {
    const p = join(dir, "empty.jsonl")
    writeFileSync(p, "", "utf-8")
    expect(readSessionMeta(p)).toBeUndefined()
  })

  test("returns undefined for a missing file", () => {
    expect(readSessionMeta(join(dir, "does-not-exist.jsonl"))).toBeUndefined()
  })

  test("meta scan of a huge transcript stays memory-bounded (19775)", () => {
    // 64MB file whose meta completes in the first 3 lines. The old
    // implementation materialized the whole file as one string PLUS a
    // split("\n") string array (≥4x the byte size in JS heap); the
    // streaming reader's peak is one 256KB chunk + one line.
    const p = join(dir, "huge.jsonl")
    writeFileSync(p, [userEntry("big session opener"), assistantEntry("ack")].join("\n") + "\n", "utf-8")
    const filler = entryLine({
      type: "assistant",
      sessionId: "11111111-2222-3333-4444-555555555555",
      timestamp: "2026-06-01T10:00:06.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "x".repeat(64 * 1024) }] },
    })
    const block = Array.from({ length: 64 }, () => filler).join("\n") + "\n"
    for (let written = 0; written < 64 * 1024 * 1024; written += block.length) {
      appendFileSync(p, block, "utf-8")
    }

    // Best-effort GC so `before` isn't inflated by setup garbage. Works under
    // both bun (Bun.gc) and node (--expose-gc); absent either, the generous
    // threshold still separates streaming (a few MB) from whole-file (≥128MB).
    const maybeBun = (globalThis as { Bun?: { gc?: (force: boolean) => void } }).Bun
    if (typeof maybeBun?.gc === "function") maybeBun.gc(true)
    ;(globalThis as { gc?: () => void }).gc?.()
    const before = process.memoryUsage().rss
    const meta = readSessionMeta(p)
    const deltaMb = (process.memoryUsage().rss - before) / (1024 * 1024)

    expect(meta?.firstUserText).toBe("big session opener")
    // Old reader: ≥ 128MB delta for a 64MB file (string + split copies).
    // Streaming reader: a few MB. 48MB is a generous flake-proof ceiling.
    expect(deltaMb, `rss delta ${Math.round(deltaMb)}MB`).toBeLessThan(48)
  })
})

describe("catchup skips quarantined sessions (19775)", () => {
  // The other half of the 19775 runaway: chats-rejected/ copies did not
  // count as "existing", so every catchup re-rendered + re-quality-gated +
  // re-rejected every quarantined session — and quarantined sessions are
  // dominated by stuck-loop monsters (hundreds of MB each). The rejected
  // copy must count as handled.
  test("a rejected session is not re-rendered by the next catchup", () => {
    const home = mkdtempSync(join(tmpdir(), "qmd-export-catchup-"))
    const projects = join(home, ".claude", "projects", "-test-project")
    const chats = join(home, "chats")
    const rejectedDir = join(home, "chats-rejected")
    mkdirSync(projects, { recursive: true })
    mkdirSync(chats, { recursive: true })

    // Stuck-loop session: one line repeated ≥10x contiguously → quality
    // gate rejects with stuck-loop:repeated-line.
    const loop = Array.from({ length: 40 }, () => assistantEntry("the same line over and over again"))
    writeFileSync(
      join(projects, "22222222-3333-4444-5555-666666666666.jsonl"),
      [
        userEntry("kick off", { sessionId: "22222222-3333-4444-5555-666666666666" }),
        ...loop.map((l) => l.replace(/11111111-2222-3333-4444-555555555555/g, "22222222-3333-4444-5555-666666666666")),
      ].join("\n") + "\n",
      "utf-8",
    )

    const env = {
      ...process.env,
      HOME: home,
      RECALL_SESSIONS_DIR: chats,
      RECALL_REJECTED_DIR: rejectedDir,
    }
    const script = fileURLToPath(new URL("../src/cli.ts", import.meta.url))
    const run = () => spawnSync("bun", [script, "export", "--catchup"], { env, encoding: "utf-8" })

    const first = run()
    expect(first.status, first.stderr).toBe(0)
    const rejectedFiles = readdirSync(rejectedDir).filter((f) => f.endsWith(".md"))
    expect(rejectedFiles).toHaveLength(1)
    const rejectedPath = join(rejectedDir, rejectedFiles[0]!)
    const mtimeAfterFirst = statSync(rejectedPath).mtimeMs

    const second = run()
    expect(second.status).toBe(0)
    // Old behavior: catchup re-rendered + rewrote the rejected file every
    // run (mtime moves). Fixed behavior: the quarantined copy counts as
    // existing, so the second catchup never touches it.
    expect(statSync(rejectedPath).mtimeMs).toBe(mtimeAfterFirst)

    rmSync(home, { recursive: true, force: true })
  })
})

describe("renderSessionMarkdown (streaming)", () => {
  test("renders the same shape as the whole-file renderer, with message count", () => {
    const p = join(dir, "render.jsonl")
    writeFileSync(
      p,
      [
        userEntry("first ask"),
        assistantEntry("answer one"),
        // Cross-session contamination — must be filtered from the body but
        // still counted by the legacy messageCount semantics (count happens
        // before the contamination filter, as in the old implementation).
        assistantEntry("contaminated", { sessionId: "99999999-8888-7777-6666-555555555555" }),
        entryLine({ type: "system", sessionId: "11111111-2222-3333-4444-555555555555", content: "sys note" }),
        userEntry("[tool result wrapped]"),
      ].join("\n") + "\n",
      "utf-8",
    )
    const meta = readSessionMeta(p)
    expect(meta).toBeDefined()
    const md = renderSessionMarkdown(meta!)
    expect(md).toContain("session_id: 11111111-2222-3333-4444-555555555555")
    expect(md).toContain("messages: 4")
    expect(md).toContain("# Session 2026-06-01 10:00")
    expect(md).toContain("> first ask")
    expect(md).toContain("## User\n\nfirst ask")
    expect(md).toContain("## Assistant\n\nanswer one")
    expect(md).not.toContain("contaminated")
    expect(md).not.toContain("[tool result wrapped]")
  })
})

describe("oversized JSONL records are bounded (27785)", () => {
  // 27785: forEachJsonlLine's `carry` grew until a newline, so ONE long record
  // was an unbounded allocation even though each read is a 256 KiB chunk. A
  // single multi-megabyte record anywhere in a transcript could exhaust
  // Recall's memory. The bound is unconditional in the reader (@cto a5c75ab2):
  // bytes past the budget are dropped while the scan continues to the next
  // newline, every later record survives, and the record is named instead of
  // lost silently. Tests drive the cap DOWN through maxRecordBytes — the
  // documented, test-only lever. Nothing can raise it.
  const CAP = 64 * 1024

  test("the budget is the reviewed constant, and a caller can only lower it", () => {
    // AC1: the reviewed budget is a named policy constant, not a per-call number.
    expect(RECORD_BYTE_LIMIT).toBe(REVIEWED_RECORD_LIMIT_BYTES)
    // A call asking for 64 MiB still gets a 4 MiB bound: it cannot be raised.
    const p = join(dir, "raise-attempt.jsonl")
    const line = assistantEntry("q".repeat(REVIEWED_RECORD_LIMIT_BYTES + 4096))
    writeFileSync(p, line + "\n", "utf-8")
    const yielded: string[] = []
    const oversized: Array<{ physicalLine: number; bytes: number; limit: number }> = []
    forEachJsonlLine(
      p,
      (l) => {
        yielded.push(l)
      },
      { maxRecordBytes: REVIEWED_RECORD_LIMIT_BYTES * 16, onOversized: (r) => oversized.push(r) },
    )
    expect(yielded).toEqual([])
    expect(oversized).toEqual([{ physicalLine: 1, bytes: line.length, limit: REVIEWED_RECORD_LIMIT_BYTES }])
  })

  test("an oversized record is not retained past the limit, is named, and the scan continues", () => {
    const p = join(dir, "oversized-record.jsonl")
    const oversizedLine = assistantEntry("x".repeat(CAP + 4096))
    writeFileSync(p, [userEntry("before"), oversizedLine, assistantEntry("after")].join("\n") + "\n", "utf-8")

    const yielded: string[] = []
    const oversized: Array<{ physicalLine: number; bytes: number; limit: number }> = []
    forEachJsonlLine(
      p,
      (line) => {
        yielded.push(line)
      },
      {
        maxRecordBytes: CAP,
        onOversized: (record) => {
          oversized.push(record)
        },
      },
    )

    // (a) the budget holds: no yielded record exceeds it.
    for (const line of yielded) expect(line.length).toBeLessThanOrEqual(CAP)
    // (b) the oversized record is named with physical line, bytes and limit.
    expect(oversized).toEqual([{ physicalLine: 2, bytes: oversizedLine.length, limit: CAP }])
    // (c) position preserved: the records around it still yield, in order.
    expect(yielded).toEqual([userEntry("before"), assistantEntry("after")])
  })

  test("a record exactly at the limit is not elided", () => {
    const p = join(dir, "exactly-at-cap.jsonl")
    const line = "c".repeat(CAP)
    writeFileSync(p, `${line}\ndddd\n`, "utf-8")
    const yielded: string[] = []
    const reports: unknown[] = []
    forEachJsonlLine(
      p,
      (l) => {
        yielded.push(l)
      },
      { maxRecordBytes: CAP, onOversized: (r) => reports.push(r) },
    )
    expect(reports).toEqual([])
    expect(yielded).toEqual([line, "dddd"])
  })

  test("real content before the budget with a whitespace tail is still named", () => {
    // @cto 57a7222: the trimmed-blank skip must read the bytes BEFORE the
    // budget too, or a record like this is discarded as blank — silently, with
    // no placeholder and no report.
    // The reviewed default cap is used on purpose: the record has to outrun the
    // 256 KiB read chunk so its non-blank prefix lands in earlier chunks and the
    // overflow happens in a whitespace-only one. (At a 64 KiB cap the whole
    // record is a single chunk and the older reader happened to report it.)
    const p = join(dir, "blank-tail.jsonl")
    const sized = `{"type":"assistant","text":"real"}${" ".repeat(REVIEWED_RECORD_LIMIT_BYTES + 4096)}`
    writeFileSync(p, [sized, assistantEntry("after the blank tail")].join("\n") + "\n", "utf-8")

    const yielded: string[] = []
    const oversized: Array<{ physicalLine: number; bytes: number; limit: number }> = []
    forEachJsonlLine(
      p,
      (line) => {
        yielded.push(line)
      },
      { onOversized: (record) => oversized.push(record) },
    )
    expect(oversized).toEqual([{ physicalLine: 1, bytes: sized.length, limit: REVIEWED_RECORD_LIMIT_BYTES }])
    expect(yielded).toEqual([assistantEntry("after the blank tail")])

    // The trimmed-blank rule is the same at any size: an entirely blank record
    // is skipped, never named — no report, no placeholder.
    const blankP = join(dir, "blank-whole.jsonl")
    writeFileSync(
      blankP,
      [" ".repeat(REVIEWED_RECORD_LIMIT_BYTES + 4096), assistantEntry("after")].join("\n") + "\n",
      "utf-8",
    )
    const reports: unknown[] = []
    const yieldedBlank: string[] = []
    forEachJsonlLine(
      blankP,
      (line) => {
        yieldedBlank.push(line)
      },
      { onOversized: (record) => reports.push(record) },
    )
    expect(reports).toEqual([])
    expect(yieldedBlank).toEqual([assistantEntry("after")])
  })

  test("a multibyte character straddling the cap boundary does not corrupt the next record", () => {
    const p = join(dir, "straddle.jsonl")
    // The retained prefix is exactly CAP bytes, so the record's final emoji,
    // starting two bytes before the cap, is cut in the middle by the budget.
    const straddling = `${"a".repeat(CAP - 2)}🤖`
    writeFileSync(p, [straddling, assistantEntry("clean next line")].join("\n") + "\n", "utf-8")

    const yielded: string[] = []
    const oversized: Array<{ physicalLine: number; bytes: number; limit: number }> = []
    forEachJsonlLine(
      p,
      (line) => {
        yielded.push(line)
      },
      { maxRecordBytes: CAP, onOversized: (record) => oversized.push(record) },
    )
    expect(oversized).toEqual([{ physicalLine: 1, bytes: Buffer.byteLength(straddling, "utf8"), limit: CAP }])
    expect(yielded).toEqual([assistantEntry("clean next line")])
    expect(yielded.some((l) => l.includes("�"))).toBe(false)
  })

  test("a record ending in a truncated multibyte sequence does not tear the next record", () => {
    // @cto 0cca6f35e review: the decoder holds a truncated sequence across the
    // newline, so feeding it to the next record makes a VALID record parse as
    // U+FFFD-prefixed junk and both consumers drop it silently. The whole-chunk
    // reader resolved the torn sequence inside record 1; the reader must keep
    // doing that.
    const p = join(dir, "torn.jsonl")
    // "a" + the first two bytes of a 3-byte sequence, then the newline.
    writeFileSync(p, Buffer.from([0x61, 0xe2, 0x82, 0x0a]), "utf-8")
    appendFileSync(p, userEntry("survives the torn neighbour") + "\n", "utf-8")

    const yielded: string[] = []
    forEachJsonlLine(p, (line) => {
      yielded.push(line)
    })
    expect(yielded).toEqual(["a\uFFFD", userEntry("survives the torn neighbour")])

    // The consumer keeps the valid record: it is parsed, exported and named.
    const meta = readSessionMeta(p)
    expect(meta?.firstUserText).toBe("survives the torn neighbour")
    expect(renderSessionMarkdown(meta!)).toContain("survives the torn neighbour")
  })

  test("a truncated sequence at EOF is not re-counted against the budget", () => {
    // The same held bytes at EOF are counted once, so an exactly-at-limit record
    // whose last bytes are a truncated sequence is not wrongly pushed over.
    const eof = join(dir, "torn-eof.jsonl")
    writeFileSync(eof, Buffer.concat([Buffer.from("a".repeat(CAP - 2)), Buffer.from([0xe2, 0x82])]), "utf-8")
    const eofLines: string[] = []
    const eofReports: unknown[] = []
    forEachJsonlLine(
      eof,
      (line) => {
        eofLines.push(line)
      },
      { maxRecordBytes: CAP, onOversized: (record) => eofReports.push(record) },
    )
    expect(eofReports).toEqual([])
    expect(eofLines).toEqual([`${"a".repeat(CAP - 2)}\uFFFD`])
  })

  test("the export names an oversized record inside and outside the export", () => {
    const p = join(dir, "oversized-export.jsonl")
    const oversizedLine = assistantEntry("y".repeat(REVIEWED_RECORD_LIMIT_BYTES + 4096))
    writeFileSync(p, [userEntry("real ask"), oversizedLine, assistantEntry("small answer")].join("\n") + "\n", "utf-8")

    const originalWrite = process.stderr.write
    const captured: string[] = []
    ;(process.stderr as unknown as { write: (chunk: string) => boolean }).write = (chunk) => {
      captured.push(String(chunk))
      return true
    }
    let md: string
    try {
      const meta = readSessionMeta(p)
      expect(meta).toBeDefined()
      md = renderSessionMarkdown(meta!)
    } finally {
      process.stderr.write = originalWrite
    }

    expect(md).toContain("## User\n\nreal ask")
    expect(md).toContain("## Assistant\n\nsmall answer")
    // Named inside the export, at the record's own position…
    expect(md).toContain("[oversized record elided: physical line 2")
    expect(md).toContain(`${oversizedLine.length} bytes, limit ${REVIEWED_RECORD_LIMIT_BYTES} bytes]`)
    // …and named outside it, by the reader's loud default — never a silent drop.
    expect(captured.join("")).toContain(`physical line 2 holds a ${oversizedLine.length}-byte jsonl record`)
    // No silently truncated copy of the elided content reached the export.
    expect(md).not.toContain("y".repeat(1024))
  })

  test("an ordinary transcript renders byte-identical Markdown", () => {
    const p = join(dir, "ordinary.jsonl")
    writeFileSync(p, [userEntry("plain ask"), "", assistantEntry("plain answer")].join("\n") + "\n", "utf-8")
    const meta = readSessionMeta(p)
    expect(meta).toBeDefined()
    expect(renderSessionMarkdown(meta!)).toBe(
      [
        "---",
        "session_id: 11111111-2222-3333-4444-555555555555",
        "started: 2026-06-01T10:00:00.000Z",
        "project: /Users/test/project",
        "messages: 2",
        `source: ${p}`,
        "---",
        "",
        "# Session 2026-06-01 10:00",
        "",
        "> plain ask",
        "",
        "## User",
        "",
        "plain ask",
        "",
        "## Assistant",
        "",
        "plain answer",
        "",
      ].join("\n"),
    )
  })

  test("a single huge record does not balloon the reader's memory (27785)", () => {
    // ONE record of >=64MB with no newline until the end. The unbounded reader
    // materialized all of it in `carry`; the bounded reader drops past the
    // budget while scanning to the newline.
    const p = join(dir, "one-huge-record.jsonl")
    const block = `{"type":"assistant","text":"${"z".repeat(8 * 1024 * 1024)}"}`
    writeFileSync(p, "", "utf-8")
    for (let written = 0; written < 64 * 1024 * 1024; written += block.length) appendFileSync(p, block, "utf-8")
    appendFileSync(p, "\n", "utf-8")

    const maybeBun = (globalThis as { Bun?: { gc?: (force: boolean) => void } }).Bun
    if (typeof maybeBun?.gc === "function") maybeBun.gc(true)
    ;(globalThis as { gc?: () => void }).gc?.()
    const before = process.memoryUsage().rss
    let longestYielded = 0
    forEachJsonlLine(
      p,
      (line) => {
        longestYielded = Math.max(longestYielded, line.length)
      },
      { onOversized: () => {} },
    )
    const deltaMb = (process.memoryUsage().rss - before) / (1024 * 1024)

    expect(longestYielded).toBe(0)
    // Unbounded carry: >= 64MB delta. Bounded reader: near the 4MB budget.
    // 48MB is a generous flake-proof ceiling, the same style as the 19775 test.
    expect(deltaMb, `rss delta ${Math.round(deltaMb)}MB`).toBeLessThan(48)
  })
})
