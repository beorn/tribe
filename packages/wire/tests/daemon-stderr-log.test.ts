/**
 * @ag/tribe/24159 — daemon-stderr tee path naming.
 *
 * Pure path/stat logic behind the supervisor's daemon-stderr tee (see
 * standalone-supervisor.ts) and `tribe doctor`'s reporting of it. No process
 * spawning here — see supervisor-daemon-stderr-log.test.ts for the L2
 * regression proving the supervisor actually writes the file.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { activityLogDir } from "../src/activity-log-contract.ts"
import { daemonStderrLogFilename, daemonStderrLogPath, describeDaemonStderrLog } from "../src/lib/daemon-stderr-log.ts"

describe("daemonStderrLogFilename", () => {
  test("pads single-digit month and day", () => {
    expect(daemonStderrLogFilename(new Date(2026, 0, 5))).toBe("daemon-stderr-2026-01-05.log")
  })

  test("no padding needed for double-digit month and day", () => {
    expect(daemonStderrLogFilename(new Date(2026, 10, 24))).toBe("daemon-stderr-2026-11-24.log")
  })
})

describe("daemonStderrLogPath", () => {
  const previous = process.env.TRIBE_DAEMON_STDERR_LOG

  afterEach(() => {
    if (previous === undefined) delete process.env.TRIBE_DAEMON_STDERR_LOG
    else process.env.TRIBE_DAEMON_STDERR_LOG = previous
  })

  test("no override → dated file under activityLogDir()", () => {
    delete process.env.TRIBE_DAEMON_STDERR_LOG
    const now = new Date(2026, 8, 4)
    expect(daemonStderrLogPath(now)).toBe(join(activityLogDir(), "daemon-stderr-2026-09-04.log"))
  })

  test("TRIBE_DAEMON_STDERR_LOG override → literal path verbatim, no rotation", () => {
    process.env.TRIBE_DAEMON_STDERR_LOG = "/tmp/pinned-daemon-stderr.log"
    expect(daemonStderrLogPath(new Date(2026, 0, 1))).toBe("/tmp/pinned-daemon-stderr.log")
    expect(daemonStderrLogPath(new Date(2099, 11, 31))).toBe("/tmp/pinned-daemon-stderr.log")
  })
})

describe("describeDaemonStderrLog", () => {
  let dir: string
  const previous = process.env.TRIBE_DAEMON_STDERR_LOG

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "daemon-stderr-log-describe-"))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    if (previous === undefined) delete process.env.TRIBE_DAEMON_STDERR_LOG
    else process.env.TRIBE_DAEMON_STDERR_LOG = previous
  })

  test("file does not exist → exists:false, sizeBytes:null, path still reported", () => {
    const path = join(dir, "not-there.log")
    process.env.TRIBE_DAEMON_STDERR_LOG = path
    expect(describeDaemonStderrLog()).toEqual({ path, exists: false, sizeBytes: null })
  })

  test("file exists → exists:true, sizeBytes matches its byte length", () => {
    const path = join(dir, "there.log")
    writeFileSync(path, "tribe-supervisor: daemon generation 123 exited with code 1\n")
    process.env.TRIBE_DAEMON_STDERR_LOG = path
    const description = describeDaemonStderrLog()
    expect(description.path).toBe(path)
    expect(description.exists).toBe(true)
    expect(description.sizeBytes).toBe(
      Buffer.byteLength("tribe-supervisor: daemon generation 123 exited with code 1\n"),
    )
  })
})
