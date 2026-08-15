/**
 * Does closing a ball cost O(pile)?
 *
 * Hypothesis under test: each close pays roughly a full pending snapshot plus
 * a write, so draining n balls is O(n^2). The discriminating signal is whether
 * per-close latency FALLS as the pile drains — if each close costs O(remaining),
 * closing at 200 owed is measurably dearer than closing at 20 owed. A flat line
 * kills the hypothesis regardless of what the saturated live daemon showed,
 * because a saturated event loop makes every RPC slow for reasons that have
 * nothing to do with this path.
 *
 * Clean room: no other load, no sockets, handler called directly.
 *
 * Usage: bun closescale.ts
 */
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTribeContext } from "../src/lib/context.ts"
import { createStatements, openDatabase } from "../src/lib/database.ts"
import { handleToolCall, type HandlerOpts } from "../src/lib/handlers.ts"

const OWNER = "@chief"
const PILE_SIZES = [20, 50, 200, 400]

const opts: HandlerOpts = {
  getActiveSessionIds: () => new Set<string>(),
  getActiveSessionInfo: () => [],
  hasActiveTransport: () => false,
  isReconnectGraceProtected: () => false,
  userRenamed: false,
  setUserRenamed: () => {},
} as unknown as HandlerOpts

function build(pile: number) {
  const dir = mkdtempSync(join(tmpdir(), `closescale-${pile}-`))
  const db = openDatabase(join(dir, "tribe.db"))
  const stmts = createStatements(db)

  const insertMessage = db.prepare(
    "INSERT INTO messages (id, type, sender, recipient, kind, content, ts, delivery, summary, request) " +
      "VALUES ($id, 'request', '@fleet', $owner, 'direct', $content, $ts, 'push', $summary, $rid)",
  )
  const insertPending = db.prepare(
    "INSERT INTO pending_request (request_id, recipient, sender, opened_at, expires_at, message_id, fanout) " +
      "VALUES ($rid, $owner, '@fleet', $opened, NULL, $mid, 'first')",
  )
  db.transaction(() => {
    for (let i = 0; i < pile; i++) {
      const rid = `req-${String(i).padStart(5, "0")}`
      insertMessage.run({
        $id: `msg-${i}`,
        $owner: OWNER,
        // A realistic body, since a snapshot that carries content pays for it.
        $content: `question ${i}: ${"x".repeat(400)}`,
        $ts: 1_000 + i,
        $summary: `summary ${i}`,
        $rid: rid,
      })
      insertPending.run({ $rid: rid, $owner: OWNER, $opened: 1_000 + i, $mid: `msg-${i}` })
    }
  })()

  const ctx = createTribeContext({
    db,
    stmts,
    sessionId: "closer",
    sessionRole: "member",
    initialName: OWNER,
    domains: [],
    claudeSessionId: null,
    claudeSessionName: null,
  })
  return { db, ctx }
}

function closeOne(ctx: ReturnType<typeof build>["ctx"], requestId: string): number {
  const started = performance.now()
  const result = handleToolCall(ctx, "tribe.pending", { owner: OWNER, close: requestId }, opts)
  const elapsed = performance.now() - started
  const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}"
  const parsed = JSON.parse(text) as { closed?: number }
  if (parsed.closed !== 1) throw new Error(`close of ${requestId} reported closed=${parsed.closed} — instrument bad`)
  return elapsed
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

/** A close whose id matches nothing: the MISS path, which builds a warning
 *  listing every open ball the owner holds. */
function closeMiss(ctx: ReturnType<typeof build>["ctx"]): { ms: number; warningChars: number } {
  const started = performance.now()
  const result = handleToolCall(ctx, "tribe.pending", { owner: OWNER, close: "req-does-not-exist" }, opts)
  const ms = performance.now() - started
  const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}"
  const parsed = JSON.parse(text) as { closed?: number; warning?: string }
  if (parsed.closed !== 0) throw new Error("expected a miss — instrument bad")
  return { ms, warningChars: parsed.warning?.length ?? 0 }
}

console.log("=== MISS path (close id matches nothing) ===")
console.log("pile | miss ms | warning chars")
console.log("-----|---------|--------------")
for (const pile of PILE_SIZES) {
  const { db, ctx } = build(pile)
  const samples: number[] = []
  let chars = 0
  for (let i = 0; i < 20; i++) {
    const one = closeMiss(ctx)
    samples.push(one.ms)
    chars = one.warningChars
  }
  console.log(`${String(pile).padStart(5)}|${median(samples).toFixed(4).padStart(9)}|${String(chars).padStart(14)}`)
  db.close()
}

console.log("")
console.log("=== HIT path (drain) ===")
console.log("pile | first-10 closes (pile large) | last-10 closes (pile small) | ratio | full drain ms")
console.log("-----|------------------------------|-----------------------------|-------|--------------")

for (const pile of PILE_SIZES) {
  const { db, ctx } = build(pile)
  const remaining = (): number => (db.prepare("SELECT count(*) AS c FROM pending_request").get() as { c: number }).c
  if (remaining() !== pile) throw new Error(`seed failed: ${remaining()} != ${pile}`)

  const samples: number[] = []
  const drainStarted = performance.now()
  for (let i = 0; i < pile; i++) {
    samples.push(closeOne(ctx, `req-${String(i).padStart(5, "0")}`))
  }
  const drainMs = performance.now() - drainStarted
  if (remaining() !== 0) throw new Error(`drain incomplete: ${remaining()} left`)

  const head = median(samples.slice(0, 10))
  const tail = median(samples.slice(-10))
  console.log(
    `${String(pile).padStart(5)}|${head.toFixed(4).padStart(30)}|${tail.toFixed(4).padStart(29)}` +
      `|${(head / Math.max(tail, 1e-9)).toFixed(2).padStart(7)}|${drainMs.toFixed(1).padStart(14)}`,
  )
  db.close()
}
