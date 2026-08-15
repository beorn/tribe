/**
 * @failure Vitest runs leaked a detached supervisor/daemon pair each time a
 *   test reached `connectOrStart` on the hermetic guard socket. The pairs
 *   reparent to init, hold a guard socket, and keep their source watcher armed,
 *   so a later `git checkout` hot-reloaded nine leaked generations at once.
 * @level l1 — pure matching rules over captured `ps` output.
 * @consumer tests/setup/reap-guard-daemons.ts, the vitest globalSetup teardown.
 *
 * The reaper sends signals, so its matching rules are the dangerous part: too
 * broad and a run kills the operator's live daemon or a peer's checkout. These
 * pin the boundary in both directions.
 */

import { describe, expect, it } from "vitest"
import { findGuardSocketProcesses } from "../../../tests/setup/reap-guard-daemons.ts"

const GUARD_ROOT = "/tmp/tribe-vitest-3001/tribe-guard/"
const REPO_ROOT = "/home/agent/work/tribe"
const OPTS = { guardRoot: GUARD_ROOT, repoRoot: REPO_ROOT, selfPid: 999 }

/** Real `ps -eo pid=,args=` lines, shortened only in the bun path. */
const LEAKED_SUPERVISOR =
  `2888173 /bin/bun ${REPO_ROOT}/packages/wire/src/cli.ts __standalone-supervisor -- ` +
  `${REPO_ROOT}/packages/daemon/src/daemon.ts --socket ${GUARD_ROOT}4e1ec6bc/tribe.sock`
const LEAKED_DAEMON = `2888282 /bin/bun ${REPO_ROOT}/packages/daemon/src/daemon.ts --socket ${GUARD_ROOT}4e1ec6bc/tribe.sock`

/** The operator's real daemon — a different socket root entirely. */
const LIVE_DAEMON =
  "2672980 bun /hh/vendor/tribe/packages/wire/src/cli.ts __standalone-supervisor -- " +
  "/hh/vendor/tribe/packages/daemon/src/daemon.ts --socket /run/user/3001/tribe.sock --idle-quit-after never"

/** Another agent's checkout, running its own suite against its own guard dir. */
const PEER_CHECKOUT_DAEMON = `3061114 /bin/bun /home/agent/other-clone/tribe/packages/daemon/src/daemon.ts --socket ${GUARD_ROOT}d9db1550/tribe.sock`

describe("guard-socket reaper matching", () => {
  it("finds the leaked supervisor and its daemon", () => {
    const found = findGuardSocketProcesses([LEAKED_SUPERVISOR, LEAKED_DAEMON].join("\n"), OPTS)
    expect(found.map((p) => p.pid)).toEqual([2888173, 2888282])
  })

  it("marks the supervisor so it can be signalled first", () => {
    const found = findGuardSocketProcesses([LEAKED_DAEMON, LEAKED_SUPERVISOR].join("\n"), OPTS)
    expect(found.find((p) => p.pid === 2888173)?.isSupervisor).toBe(true)
    expect(found.find((p) => p.pid === 2888282)?.isSupervisor).toBe(false)
  })

  it("NEVER matches the live per-user daemon", () => {
    // The single most important assertion in this file: the live rail is the
    // thing an over-broad reaper would take down.
    expect(findGuardSocketProcesses(LIVE_DAEMON, OPTS)).toEqual([])
  })

  it("never matches another checkout's run, even on the shared guard root", () => {
    // /tmp/tribe-vitest-<uid> is shared across every clone on the box, so the
    // guard root alone is not enough to prove a process is ours.
    expect(findGuardSocketProcesses(PEER_CHECKOUT_DAEMON, OPTS)).toEqual([])
  })

  it("never matches this process itself", () => {
    const self = `999 /bin/bun ${REPO_ROOT}/x --socket ${GUARD_ROOT}abc/tribe.sock`
    expect(findGuardSocketProcesses(self, OPTS)).toEqual([])
  })

  it("never matches pid 1", () => {
    const init = `1 /bin/bun ${REPO_ROOT}/x --socket ${GUARD_ROOT}abc/tribe.sock`
    expect(findGuardSocketProcesses(init, OPTS)).toEqual([])
  })

  it("ignores unrelated processes and blank lines", () => {
    const noise = ["", "  ", "4242 /usr/bin/node server.js", `4243 /bin/bun ${REPO_ROOT}/packages/daemon/src/daemon.ts`]
    expect(findGuardSocketProcesses([...noise, LEAKED_DAEMON].join("\n"), OPTS).map((p) => p.pid)).toEqual([2888282])
  })
})
