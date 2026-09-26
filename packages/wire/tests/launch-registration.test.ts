/**
 * connectTribeLaunch certifies the launch identity the daemon keyed (25074, @cto b58e4715 and 95c2be2d). The client never
 * omits the launch id it was given: a register sends its token AND its derived launch id, and the daemon decides the
 * keying. A verified token keys `<sid>@<gen>`, which only the daemon knows, so `register` returns the identity it keyed
 * and the client certifies its members row against that. The returned id must be the derived one or that seat's
 * `<sid>@<gen>`, never another launch. An old daemon that returns none keeps the derived-id certification, so an old
 * daemon plus this client keeps joining (@cto 57e5f42a). sessionId alone never certifies.
 */
import { describe, expect, it, vi } from "vitest"
import {
  REREGISTER_WINDOW_MS,
  connectTribeLaunch,
  type TribeLaunchDeps,
  type TribeLaunchRequest,
} from "../src/launch-registration.ts"

const PID = 4242
const REQUEST: TribeLaunchRequest = {
  name: "@dev/7",
  principalClass: "agent",
  launchId: "sid-dev7",
  cwd: "/tmp/p",
  domains: [],
  takeover: true,
}
const DERIVED = "sid-dev7::%40dev%2F7"

/** An unsigned JWT-shaped token carrying `claims`: the client reads claims unverified, and only the daemon verifies. */
function tokenWithClaims(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
  return `${part({ alg: "EdDSA", typ: "hab-id+jwt" })}.${part(claims)}.signature`
}

/** A daemon that answers register with `registered` and lists one member row keyed `rowLaunchId`. */
function fakeDaemon(registered: Record<string, unknown>, rowLaunchId: string) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const connect: TribeLaunchDeps["connect"] = async () => ({
    call: vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params })
      if (method === "register") return { name: REQUEST.name, principalClass: "agent", ...registered }
      const row = {
        name: REQUEST.name,
        launch_id: rowLaunchId,
        launch_parent_pid: PID,
        transport_state: "connected",
        delivery: "pull",
        alive: true,
        cwd: REQUEST.cwd,
      }
      return { content: [{ text: JSON.stringify({ sessions: [row] }) }] }
    }) as never,
    close: vi.fn(),
    socket: { unref: vi.fn(), destroyed: false },
  })
  const deps: TribeLaunchDeps = { connect, socketPath: () => "/tmp/sock", sleep: async () => {}, processId: () => PID }
  return { deps, calls }
}

describe("connectTribeLaunch certifies the launch identity the daemon keyed (25074)", () => {
  it("a token register sends its launch id too, certifies the returned <sid>@<gen>, and its child env projects no launch id (3d-2b)", async () => {
    const { deps, calls } = fakeDaemon({ launchId: "sid-dev7@3", launchParentPid: PID }, "sid-dev7@3")

    const joined = await connectTribeLaunch({ ...REQUEST, idToken: "seat-token" }, deps)

    const register = calls.find((call) => call.method === "register")?.params
    expect(register).toMatchObject({ launchId: DERIVED, launchParentPid: PID, idToken: "seat-token" })
    expect(joined.launchId).toBe("sid-dev7@3")
    // 25074 3d-2b: the registered child keys by its own token's sid; the env clears TRIBE_LAUNCH_ID, never sets it.
    expect(joined.environment).toHaveProperty("TRIBE_LAUNCH_ID", undefined)
    expect(joined.environment.TRIBE_LAUNCH_PARENT_PID).toBe(String(PID))
  })

  it("a token register the daemon keyed by its launch id (an undecided token) certifies the derived id", async () => {
    const { deps } = fakeDaemon({ launchId: DERIVED, launchParentPid: PID }, DERIVED)

    const joined = await connectTribeLaunch({ ...REQUEST, idToken: "hab-job-token" }, deps)

    expect(joined.launchId).toBe(DERIVED)
  })

  it("a token register keyed as another seat's launch refuses, naming both", async () => {
    const { deps } = fakeDaemon({ launchId: "sid-other@3", launchParentPid: PID }, "sid-other@3")

    await expect(connectTribeLaunch({ ...REQUEST, idToken: "seat-token" }, deps)).rejects.toThrow(
      `the daemon keyed launch sid-other@3, not the derived ${DERIVED} or its seat's sid-dev7@<gen>`,
    )
  })

  it("a register without a token whose returned id differs from the derived one refuses, naming both", async () => {
    const { deps } = fakeDaemon({ launchId: "some-other-launch", launchParentPid: PID }, "some-other-launch")

    await expect(connectTribeLaunch(REQUEST, deps)).rejects.toThrow(
      `the daemon keyed launch some-other-launch, not the derived ${DERIVED}`,
    )
  })

  it("an old daemon that returns no launch id keeps the derived-id certification, with a token or without", async () => {
    for (const request of [REQUEST, { ...REQUEST, idToken: "seat-token" }]) {
      const { deps, calls } = fakeDaemon({ sessionId: "s-1" }, DERIVED)

      const joined = await connectTribeLaunch(request, deps)

      expect(calls.find((call) => call.method === "register")?.params).toMatchObject({ launchId: DERIVED })
      expect(joined.launchId).toBe(DERIVED)
      expect(joined.environment).toHaveProperty("TRIBE_LAUNCH_ID", undefined)
    }
  })

  // 25074 §18(a) (@cto 027f0c0c): a hab-launched sender presents the launch id it was given — its token's sid — never
  // a minted one. The client reads the sid unverified to form the id; the daemon verifies the token.
  describe("a launch id from the token's sid", () => {
    const RUN_SID = "state-checkout-sync:manual:1790253346128"
    const runToken = tokenWithClaims({ sid: RUN_SID, gen: 0, act: { sub: "state-checkout-sync", kind: "service" } })
    const { launchId: _given, ...withoutLaunchId } = REQUEST

    it("a verifying run token with no launch id registers under its sid and certifies the daemon's <sid>@<gen>", async () => {
      const derived = `${RUN_SID}::${encodeURIComponent(REQUEST.name)}`
      const { deps, calls } = fakeDaemon({ launchId: `${RUN_SID}@0`, launchParentPid: PID }, `${RUN_SID}@0`)

      const joined = await connectTribeLaunch({ ...withoutLaunchId, idToken: runToken }, deps)

      expect(calls.find((call) => call.method === "register")?.params).toMatchObject({ launchId: derived })
      expect(joined.launchId).toBe(`${RUN_SID}@0`)
    })

    it("a minted launch id beside a token naming another sid is refused before any register, naming both", async () => {
      const { deps, calls } = fakeDaemon({}, DERIVED)

      await expect(
        connectTribeLaunch({ ...withoutLaunchId, launchId: "0b6f7f2e-minted", idToken: runToken }, deps),
      ).rejects.toThrow(`launch id 0b6f7f2e-minted is not this token's sid ${RUN_SID}`)
      expect(calls).toEqual([])
    })

    it("a register with neither a launch id nor a token is refused before any register", async () => {
      const { deps, calls } = fakeDaemon({}, DERIVED)

      await expect(connectTribeLaunch(withoutLaunchId, deps)).rejects.toThrow(
        "has neither a launch id nor an identity token",
      )
      expect(calls).toEqual([])
    })
  })

  it("a returned parent pid that is not this client's refuses, naming both", async () => {
    const { deps } = fakeDaemon({ launchId: "sid-dev7@3", launchParentPid: PID + 1 }, "sid-dev7@3")

    await expect(connectTribeLaunch({ ...REQUEST, idToken: "seat-token" }, deps)).rejects.toThrow(
      `the daemon keyed launch parent pid ${PID + 1}, not this harness's ${PID}`,
    )
  })
})

/**
 * @failure 25074 acceptance 4: a long-lived service registers once, a wire restart drops its owner transport, and every
 * later send is refused as an unroutable launch until the process restarts (coordination-watch never healed).
 * ensureRegistered re-presents the same registration once the daemon is back, and only then.
 */
describe("ensureRegistered re-registers a launch the daemon dropped (25074 acceptance 4)", () => {
  /** A daemon whose owner socket can be dropped, and whose connects can be refused while it restarts. */
  function restartableDaemon() {
    const sockets: Array<{ destroyed: boolean; dead: boolean }> = []
    let refuseConnects = 0
    let pid = PID
    const registers: Array<Record<string, unknown>> = []
    const connect: TribeLaunchDeps["connect"] = async () => {
      if (refuseConnects > 0) {
        refuseConnects -= 1
        throw Object.assign(new Error("connect ECONNREFUSED /tmp/sock"), { code: "ECONNREFUSED" })
      }
      const socket = { unref: vi.fn(), destroyed: false, dead: false }
      sockets.push(socket)
      return {
        call: vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
          // A dead peer never answers; a half-open socket still reads connected (destroyed false).
          if (socket.dead) throw new Error(`request ${method} timed out`)
          if (method === "cli_daemon") return { pid: 1 }
          if (method === "register") {
            registers.push(params)
            return { name: REQUEST.name, principalClass: "service", launchId: DERIVED, launchParentPid: pid }
          }
          const row = {
            name: REQUEST.name,
            launch_id: DERIVED,
            launch_parent_pid: pid,
            transport_state: "connected",
            delivery: "pull",
            alive: true,
            cwd: REQUEST.cwd,
          }
          return { content: [{ text: JSON.stringify({ sessions: [row] }) }] }
        }) as never,
        close: vi.fn(() => {
          socket.destroyed = true
        }),
        socket,
      }
    }
    let now = 1_000_000
    const deps: TribeLaunchDeps = {
      connect,
      socketPath: () => "/tmp/sock",
      sleep: async (ms) => {
        now += ms
        vi.setSystemTime(now)
      },
      processId: () => pid,
    }
    return {
      deps,
      registers,
      restart: (refusedConnects: number) => {
        for (const socket of sockets) Object.assign(socket, { destroyed: true, dead: true })
        refuseConnects = refusedConnects
      },
      /** From the next register on, this client presents (and the daemon keys) another harness pid. */
      changePid: (next: number) => {
        pid = next
      },
      /** The daemon restarted, but this client has not consumed the EOF: its flag still reads connected. */
      restartHalfOpen: () => {
        for (const socket of sockets) socket.dead = true
      },
      startClock: () => {
        vi.useFakeTimers({ toFake: ["Date"] })
        vi.setSystemTime(now)
      },
    }
  }
  const SERVICE: TribeLaunchRequest = { ...REQUEST, principalClass: "service" }

  it("is a no-op while the owner transport is connected", async () => {
    const daemon = restartableDaemon()
    const joined = await connectTribeLaunch(SERVICE, daemon.deps)
    await joined.ensureRegistered()
    expect(daemon.registers).toHaveLength(1)
    expect(joined.isConnected()).toBe(true)
  })

  it("after a restart, waits out refused connects and re-presents the same registration", async () => {
    const daemon = restartableDaemon()
    const joined = await connectTribeLaunch(SERVICE, daemon.deps)
    daemon.restart(5)
    expect(joined.isConnected()).toBe(false)
    daemon.startClock()
    try {
      await joined.ensureRegistered()
    } finally {
      vi.useRealTimers()
    }
    expect(joined.isConnected()).toBe(true)
    expect(daemon.registers).toHaveLength(2)
    expect(daemon.registers[1]).toEqual(daemon.registers[0])
  })

  it("half-open: the flag still reads connected, but the daemon does not answer, so it re-registers (@cto 8ed8ce41 (a))", async () => {
    const daemon = restartableDaemon()
    const joined = await connectTribeLaunch(SERVICE, daemon.deps)
    daemon.restartHalfOpen()
    expect(joined.isConnected()).toBe(true)
    await joined.ensureRegistered()
    expect(daemon.registers).toHaveLength(2)
  })

  it("throws, naming the launch, socket and time spent, when the daemon does not come back within the window", async () => {
    const daemon = restartableDaemon()
    const joined = await connectTribeLaunch(SERVICE, daemon.deps)
    daemon.restart(Number.POSITIVE_INFINITY)
    daemon.startClock()
    try {
      await expect(joined.ensureRegistered()).rejects.toThrow(
        new RegExp(
          `could not re-register @dev/7 \\(launch ${DERIVED}\\) at /tmp/sock after \\d+s of trying \\(window ${REREGISTER_WINDOW_MS / 1_000}s\\)`,
          "u",
        ),
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it("a re-register keyed under another pid throws at once, naming both, and is not retried for the window", async () => {
    const daemon = restartableDaemon()
    const joined = await connectTribeLaunch(SERVICE, daemon.deps)
    daemon.restart(0)
    daemon.changePid(PID + 1)
    // The clock advances with each backoff sleep, so a retrying implementation fails fast, on its window message.
    daemon.startClock()
    try {
      await expect(joined.ensureRegistered()).rejects.toThrow(
        new RegExp(
          `re-registered @dev/7 as launch ${DERIVED} under pid ${PID + 1}, not its own ${DERIVED} under pid ${PID}`,
          "u",
        ),
      )
    } finally {
      vi.useRealTimers()
    }
    expect(daemon.registers).toHaveLength(2)
  })

  it("refuses once its owner closed it", async () => {
    const daemon = restartableDaemon()
    const joined = await connectTribeLaunch(SERVICE, daemon.deps)
    joined.close()
    await expect(joined.ensureRegistered()).rejects.toThrow(/closed by its owner/u)
    expect(daemon.registers).toHaveLength(1)
  })
})
