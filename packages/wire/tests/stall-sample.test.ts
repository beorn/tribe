/**
 * @failure  a Wire CLI timeout carries no stall-time /proc sample, so swap vs event-loop vs WAL stay indistinguishable
 * @level    l2
 * @consumer 27089-wire-daemon-stalls
 * @testonly none
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { collectStallSample } from "../src/stall-sample.ts"

/**
 * #27089: a timeout used to carry no stall-time evidence, so swap vs event-loop
 * vs WAL checkpoint stayed indistinguishable. This owns the /proc+WAL parse.
 */
describe("collectStallSample", () => {
  let dir: string

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it("reads wchan, status, io delta, and WAL size from a proc tree", () => {
    dir = mkdtempSync(join(tmpdir(), "tribe-stall-sample-"))
    const pid = 2677788
    const proc = join(dir, String(pid))
    mkdirSync(proc)
    writeFileSync(join(proc, "wchan"), "futex_wait_queue")
    writeFileSync(
      join(proc, "status"),
      ["Name:\tbun", "State:\tD (disk sleep)", "VmRSS:\t  241000 kB", "VmSwap:\t    4096 kB", ""].join("\n"),
    )
    writeFileSync(join(proc, "io"), ["rchar: 9", "read_bytes: 5000", "write_bytes: 1", ""].join("\n"))
    const dbPath = join(dir, "tribe.db")
    writeFileSync(dbPath, "db")
    writeFileSync(`${dbPath}-wal`, "w".repeat(38))

    const sample = collectStallSample({
      pid,
      procRoot: dir,
      dbPath,
      ioReadBytesAtStart: 4000,
    })

    expect(sample).toMatchObject({
      pid,
      wchan: "futex_wait_queue",
      state: "D",
      vmRssKb: 241000,
      vmSwapKb: 4096,
      ioReadBytes: 5000,
      ioReadBytesDelta: 1000,
      walBytes: 38,
      dbPath,
    })
    expect(sample.unavailable).toBeUndefined()
  })

  it("names each missing /proc file instead of throwing", () => {
    dir = mkdtempSync(join(tmpdir(), "tribe-stall-sample-missing-"))
    const sample = collectStallSample({
      pid: 1,
      procRoot: dir,
      dbPath: join(dir, "no-such.db"),
    })
    expect(sample.pid).toBe(1)
    expect(sample.wchan).toBeNull()
    expect(sample.state).toBeNull()
    expect(sample.vmRssKb).toBeNull()
    expect(sample.vmSwapKb).toBeNull()
    expect(sample.ioReadBytes).toBeNull()
    expect(sample.walBytes).toBeNull()
    expect(sample.errors?.length).toBeGreaterThan(0)
  })
})
