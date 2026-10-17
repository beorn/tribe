/**
 * @failure Two real hook processes append to the shared injection record at once, and the writer's occupancy
 *          check and its append are separate operations: both can measure the same live length before either
 *          one appends, so the pair ends up past the ruling's 64 MiB — @dev/review2's r3 counterexample
 *          (M=32 MiB, L=1 MiB: previous = M−R, live = M−R−L, both approve their L-byte row, live = M−R+L,
 *          pair = 64 MiB + 896 KiB). A reserve below the ceiling cannot bound that: the window it must cover is
 *          another writer's row, and a peer's row is not bounded by loggily's buffer.
 * @level l2 — two real bun processes, a real kernel flock, and a real record on disk
 * @consumer @ag/hab/29681-every-log-writer-goes-through/bound-the-tribe-injection-record, and the reader this
 *           writer feeds: packages/daemon/src/lib/hook-latency-reader.ts, which reads the live record and its
 *           one previous segment.
 * @reach fs-walk <fixture-only: an mkdtemp scratch directory, written by the writer under test>
 * @testonly none
 *
 * The second writer is a REAL process, not a simulated one: tests/fixtures/injection-record-child.ts installs
 * the production writer on the shared record and appends only when this row tells it to, so the peer in the
 * schedule below is another hook process rather than this test's own file handle.
 *
 * The bound this row proves is the RULING's, not a copy of the implementation's arithmetic: the writer must
 * exclude a peer across the whole measure-then-append window, so the peer row below lands where the
 * counterexample puts it — after any measurement the writer could have made — and the pair must still hold.
 */

import { spawn, type ChildProcess } from "node:child_process"
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { acquireFlockBlocking, tryAcquireFlock } from "@bearly/flock"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { injectionRecordLockPath, RECORD_PREVIOUS_SEGMENT_SUFFIX } from "../src/debug.ts"

const CHILD = fileURLToPath(new URL("./fixtures/injection-record-child.ts", import.meta.url))

const MIB = 1024 * 1024
/** The ruling's ceiling for the live record plus its one previous segment. */
const RECORD_TOTAL_BOUND = 64 * MIB
/** Its per-segment half: no append may carry the live record past this. */
const SEGMENT_BOUND = RECORD_TOTAL_BOUND / 2
/**
 * The margin below the ceiling that the retired reserve left for bytes no check could see. Seeding the live
 * record exactly this far under the ceiling is what makes the boundary row below approve under that
 * arithmetic and rotate under a writer that excludes its peer.
 */
const RETIRED_RESERVE = 64 * 1024
let dir: string
const live: ChildProcess[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "inj-record-concurrent-"))
})

afterEach(() => {
  while (live.length) live.pop()?.kill("SIGKILL")
  rmSync(dir, { recursive: true, force: true })
})

function sizeOf(path: string): number {
  return existsSync(path) ? statSync(path).size : 0
}

/** A stdout line source whose timed-out read takes its waiter back, so a late line stays queued for the next read. */
function lineReader(stream: NodeJS.ReadableStream) {
  let buffer = ""
  const queued: string[] = []
  type Waiter = { deliver: (line: string) => void; timer: NodeJS.Timeout }
  const waiters: Waiter[] = []
  stream.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8")
    for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      const waiter = waiters.shift()
      if (waiter === undefined) queued.push(line)
      else {
        clearTimeout(waiter.timer)
        waiter.deliver(line)
      }
    }
  })
  return {
    /** The next line, or null if none arrives within `ms` (and this reader keeps waiting for the next call). */
    next(ms: number): Promise<string | null> {
      const queuedLine = queued.shift()
      if (queuedLine !== undefined) return Promise.resolve(queuedLine)
      return new Promise<string | null>((resolve) => {
        const waiter: Waiter = {
          deliver: (line) => resolve(line),
          timer: setTimeout(() => {
            const at = waiters.indexOf(waiter)
            if (at >= 0) waiters.splice(at, 1)
            resolve(null)
          }, ms),
        }
        waiters.push(waiter)
      })
    },
  }
}

function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  // HOME confines the child's fallback record to the fixture; the two path variables would install a second
  // writer beside the one this row targets.
  env.HOME = dir
  delete env.INJECTION_DEBUG_LOG
  delete env.LOGGILY_FILE
  return env
}

/** Start one real second hook process on the shared record; it reports `ready` once its writer is installed. */
function startChild(path: string): {
  child: ChildProcess
  reader: ReturnType<typeof lineReader>
  childStderr: () => string
} {
  const child = spawn(process.execPath, [CHILD, path], { env: childEnv(), stdio: ["pipe", "pipe", "pipe"] })
  live.push(child)
  // A child that cannot take the record lock says so on stderr; swallowing it would make the schedule below
  // unattributable, so it is carried into the failure message.
  let stderrText = ""
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrText += chunk.toString("utf8")
  })
  const reader = lineReader(child.stdout!)
  return { child, reader, childStderr: () => stderrText }
}

/** Start one real second hook process on the shared record and wait until its writer is installed. */
async function spawnChild(path: string): Promise<{
  child: ChildProcess
  reader: ReturnType<typeof lineReader>
  childStderr: () => string
}> {
  const started = startChild(path)
  const ready = await started.reader.next(30_000)
  if (ready !== "ready") {
    throw new Error(`fixture child never reported ready: ${JSON.stringify(ready)} — stderr: ${started.childStderr()}`)
  }
  return started
}

describe("injection record — a second process appending at the same time", () => {
  test("a peer row lands where the writer's measurement cannot see it, and the pair still holds the ceiling", async () => {
    const path = join(dir, "injection.jsonl")
    // The counterexample's own numbers: the previous segment sits at the reserve-adjusted ceiling and the live
    // record exactly one row under it, so one more row is the boundary case.
    writeFileSync(`${path}.1`, "p".repeat(SEGMENT_BOUND - RETIRED_RESERVE))
    writeFileSync(path, "l".repeat(SEGMENT_BOUND - RETIRED_RESERVE - MIB))

    const { child, reader, childStderr } = await spawnChild(path)

    // The peer — this test, holding exactly what a second hook process would — owns the record's lock first.
    const lock = acquireFlockBlocking(injectionRecordLockPath(path))
    let early: string | null = "the writer never answered"
    try {
      child.stdin!.write(`emit ${MIB}\n`)
      early = await reader.next(500)
      // The peer row the writer's measurement cannot see, written inside the critical section the writer must
      // wait for. A writer that appends without the lock writes before this line, and past the ceiling.
      appendFileSync(path, "q".repeat(MIB) + "\n")
    } finally {
      lock.release()
    }

    expect(
      early,
      `the writer appended while another process held the record lock — child stderr: ${childStderr()}`,
    ).toBeNull()
    expect(await reader.next(30_000), "the writer never finished the row it was blocked on").toBe("written")

    const liveBytes = sizeOf(path)
    const previousBytes = sizeOf(`${path}.1`)

    expect(liveBytes, "no append may carry the live record past its ceiling").toBeLessThanOrEqual(SEGMENT_BOUND)
    expect(liveBytes + previousBytes).toBeLessThanOrEqual(RECORD_TOTAL_BOUND)
    // The row is not lost to the exclusion: it is on disk, in the segment the rotation opened for it.
    expect(sizeOf(path)).toBeGreaterThan(0)

    // And the lock is given back, so the next hook process is not wedged behind this one.
    const again = tryAcquireFlock(injectionRecordLockPath(path))
    expect(again, "the writer left the record locked after it finished").not.toBeNull()
    again?.release()
  })
})

/**
 * The same shared record, rotated by the OTHER writer. Every hook process keeps one open descriptor for the record
 * for its whole life, and a rotation is a rename: the process that rotates opens a fresh file, while every peer's
 * descriptor still points at the inode that was renamed aside. This writer measures `<path>` and appends through its
 * descriptor, so unless it notices the seam it writes its row into `<path>.1` — a row the reader tailing the live
 * record never sees, declared in the previous segment by a process that never looked at it. (@dev/review2, 2026-10-16:
 * "confirm whether the writer is reopened under each lock after peer rotation; the existing persistent FD was part of
 * the prior finding".)
 *
 * @failure A peer rotates the record while this writer is idle; this writer's persistent descriptor follows the
 *   renamed inode, so its next row lands in `<path>.1` while it measures `<path>`.
 * @level   l2 — two real bun processes, a real rename, and a real record on disk
 * @consumer @ag/hab/29681-every-log-writer-goes-through/bound-the-tribe-injection-record, and the reader this writer
 *           feeds: packages/daemon/src/lib/hook-latency-reader.ts, which tails the live record.
 * @reach fs-walk <fixture-only: an mkdtemp scratch directory, written by the writer under test>
 * @testonly none
 */
describe("injection record — a peer rotates the record while this writer is idle", () => {
  /** How many rows in `text` carry `marker`. */
  function rows(text: string, marker: string): number {
    return text.split("\n").filter((line) => line.includes(marker)).length
  }

  test("the next row lands in the live segment, not in the segment the peer renamed aside", async () => {
    const path = join(dir, "injection.jsonl")
    const { child, reader, childStderr } = await spawnChild(path)

    // This writer's first row, on the record as installed.
    child.stdin!.write("emit 1024\n")
    expect(await reader.next(30_000), `the writer never wrote its first row — stderr: ${childStderr()}`).toBe("written")
    expect(rows(readFileSync(path, "utf8"), "child-row"), "the first row is in the live record").toBe(1)

    // The peer: a second hook process rotates the record while this writer sits idle — rename the live segment
    // aside, then open a fresh live record and put its own row in it, which is exactly this writer's own rotate()
    // one process over.
    renameSync(path, `${path}${RECORD_PREVIOUS_SEGMENT_SUFFIX}`)
    writeFileSync(path, `${JSON.stringify({ ts: new Date().toISOString(), reason: "a-peer-opened-this-segment" })}\n`)

    child.stdin!.write("emit 1024\n")
    expect(
      await reader.next(30_000),
      `the writer never finished the row after the peer rotated — stderr: ${childStderr()}`,
    ).toBe("written")

    const live = readFileSync(path, "utf8")
    const previous = readFileSync(`${path}${RECORD_PREVIOUS_SEGMENT_SUFFIX}`, "utf8")

    expect(live, "the peer's own row stays in the live record").toContain("a-peer-opened-this-segment")
    expect(
      rows(previous, "child-row"),
      "the row written after the peer's rotation followed the renamed inode into the previous segment",
    ).toBe(1)
    expect(rows(live, "child-row"), "the row written after the peer's rotation must land in the live segment").toBe(1)
  })
})

/**
 * The window before the first row. The writer's whole staleness test is "the inode I am holding is not the inode at
 * this path", and holding an inode means two steps that must agree: opening the descriptor, and reading what the path
 * is. Unlocked, those two steps are a schedule: A opens the segment that is live, B rotates and opens a fresh one, A
 * reads the path and labels its OLD descriptor with B's NEW inode — A's first append then finds them equal, skips the
 * reopen and writes into `<path>.1` while measuring `<path>`. (The reviewer's own schedule, `@dev/review2`
 * 2026-10-16, asked before his verdict on the fix for rotation after the first row.)
 *
 * @failure The install's open and the path stat that pairs a descriptor with an inode are outside the record lock, so
 *   a peer's rotation between them labels a stale descriptor with the live inode.
 * @level   l2 — two real processes and the real kernel lock
 * @consumer @ag/hab/29681-every-log-writer-goes-through/bound-the-tribe-injection-record
 * @reach fs-walk <fixture-only: an mkdtemp scratch directory, written by the writer under test>
 * @testonly none
 */
describe("injection record — this writer's own install", () => {
  test("the descriptor and the inode it will be compared against are established under the record lock", async () => {
    const path = join(dir, "injection.jsonl")
    writeFileSync(path, "")

    // The peer holds the exclusion first. Install is the pair the lock protects - open, then read what the path is -
    // so it waits here, and the child says nothing at all until the peer is finished.
    const lock = acquireFlockBlocking(injectionRecordLockPath(path))
    const started = startChild(path)
    let early: string | null
    try {
      early = await started.reader.next(4_000)
    } finally {
      lock.release()
    }
    expect(
      early,
      `the writer installed without the record lock, so its descriptor and its inode can be paired across a peer's rotation — child stderr: ${started.childStderr()}`,
    ).toBeNull()

    // It was alive and held, not dead: released, it installs and reports ready.
    expect(await started.reader.next(30_000), `the child never reported ready — stderr: ${started.childStderr()}`).toBe(
      "ready",
    )

    // And its first row lands in the live record.
    started.child.stdin!.write("emit 1024\n")
    expect(await started.reader.next(30_000), "the writer never wrote its first row").toBe("written")
    expect(readFileSync(path, "utf8"), "the first row is in the live record").toContain("child-row")
  })
})
