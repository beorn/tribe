/**
 * connectTribeLaunch certifies the launch identity the daemon keyed (25074 3c-2b, @cto b58e4715). A token register sends
 * no launch id, and the daemon keys it `<sid>@<gen>`, which only the daemon knows; `register` returns the identity it
 * keyed and the client certifies its members row against that. Without a token the returned id must equal the one
 * the client derived. An old daemon that returns none keeps the derived-id certification. sessionId alone never
 * certifies.
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

describe("connectTribeLaunch certifies the launch identity the daemon keyed (25074 3c-2b)", () => {
  it("a token register sends no launch id and certifies against the returned <sid>@<gen>, projecting no TRIBE_LAUNCH_ID", async () => {
    const { deps, calls } = fakeDaemon({ launchId: "sid-dev7@3", launchParentPid: PID }, "sid-dev7@3")

    const joined = await connectTribeLaunch({ ...REQUEST, idToken: "seat-token" }, deps)

    const register = calls.find((call) => call.method === "register")?.params
    expect(register).not.toHaveProperty("launchId")
    expect(register).toMatchObject({ launchParentPid: PID, idToken: "seat-token" })
    expect(joined.launchId).toBe("sid-dev7@3")
    expect(joined.environment.TRIBE_LAUNCH_ID).toBeUndefined()
    expect(joined.environment.TRIBE_LAUNCH_PARENT_PID).toBe(String(PID))
  })

  it("a register without a token whose returned id differs from the derived one refuses, naming both", async () => {
    const { deps } = fakeDaemon({ launchId: "some-other-launch", launchParentPid: PID }, "some-other-launch")

    await expect(connectTribeLaunch(REQUEST, deps)).rejects.toThrow(
      `the daemon keyed launch some-other-launch, not the derived ${DERIVED}`,
    )
  })

  it("a daemon that returns no launch id keeps the derived-id certification", async () => {
    const { deps } = fakeDaemon({}, DERIVED)

    const joined = await connectTribeLaunch(REQUEST, deps)

    expect(joined.launchId).toBe(DERIVED)
    expect(joined.environment.TRIBE_LAUNCH_ID).toBe(DERIVED)
  })

  it("a returned parent pid that is not this client's refuses, naming both", async () => {
    const { deps } = fakeDaemon({ launchId: "sid-dev7@3", launchParentPid: PID + 1 }, "sid-dev7@3")

    await expect(connectTribeLaunch({ ...REQUEST, idToken: "seat-token" }, deps)).rejects.toThrow(
      `the daemon keyed launch parent pid ${PID + 1}, not this harness's ${PID}`,
    )
  })

  it("a token register the daemon returns no launch id for is refused: sessionId alone never certifies", async () => {
    const { deps } = fakeDaemon({ sessionId: "s-1" }, "sid-dev7@3")

    await expect(connectTribeLaunch({ ...REQUEST, idToken: "seat-token" }, deps)).rejects.toThrow(
      "returned no launch identity for a token register",
    )
  })
})
