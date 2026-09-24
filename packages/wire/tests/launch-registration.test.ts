/**
 * connectTribeLaunch certifies the launch identity the daemon keyed (25074, @cto b58e4715 and 95c2be2d). The client never
 * omits the launch id it was given: a register sends its token AND its derived launch id, and the daemon decides the
 * keying. A verified token keys `<sid>@<gen>`, which only the daemon knows, so `register` returns the identity it keyed
 * and the client certifies its members row against that. The returned id must be the derived one or that seat's
 * `<sid>@<gen>`, never another launch. An old daemon that returns none keeps the derived-id certification, so an old
 * daemon plus this client keeps joining (@cto 57e5f42a). sessionId alone never certifies.
 */
import { describe, expect, it, vi } from "vitest"
import { connectTribeLaunch, type TribeLaunchDeps, type TribeLaunchRequest } from "../src/launch-registration.ts"

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
  it("a token register sends its launch id too, certifies the returned <sid>@<gen> and still projects TRIBE_LAUNCH_ID", async () => {
    const { deps, calls } = fakeDaemon({ launchId: "sid-dev7@3", launchParentPid: PID }, "sid-dev7@3")

    const joined = await connectTribeLaunch({ ...REQUEST, idToken: "seat-token" }, deps)

    const register = calls.find((call) => call.method === "register")?.params
    expect(register).toMatchObject({ launchId: DERIVED, launchParentPid: PID, idToken: "seat-token" })
    expect(joined.launchId).toBe("sid-dev7@3")
    expect(joined.environment.TRIBE_LAUNCH_ID).toBe(DERIVED)
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
      expect(joined.environment.TRIBE_LAUNCH_ID).toBe(DERIVED)
    }
  })

  it("a returned parent pid that is not this client's refuses, naming both", async () => {
    const { deps } = fakeDaemon({ launchId: "sid-dev7@3", launchParentPid: PID + 1 }, "sid-dev7@3")

    await expect(connectTribeLaunch({ ...REQUEST, idToken: "seat-token" }, deps)).rejects.toThrow(
      `the daemon keyed launch parent pid ${PID + 1}, not this harness's ${PID}`,
    )
  })
})
