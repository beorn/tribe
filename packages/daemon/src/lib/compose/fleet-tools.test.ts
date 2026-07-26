/**
 * fleetTools registry wrappers (21743) — inject run(), no live tent.
 */
import { describe, expect, test } from "vitest"
import { fleetTools } from "./fleet-tools.ts"

describe("fleetTools", () => {
  test("fleet.read parses tent JSON; filters seats", async () => {
    const tools = fleetTools({
      projectRoot: "/repo",
      run: () => ({
        status: 0,
        stdout: JSON.stringify({
          generatedAt: "t0",
          seats: [
            { seat: "@dev/1", posture: "working" },
            { seat: "@fleet", posture: "waiting" },
          ],
        }),
        stderr: "",
      }),
    })
    const read = tools.find((t) => t.name === "fleet.read")!
    const all = (await read.handler({}, {})) as { seats: Array<{ seat: string }> }
    expect(all.seats).toHaveLength(2)
    const workers = (await read.handler({ seats: "role:worker" }, {})) as {
      seats: Array<{ seat: string }>
    }
    expect(workers.seats.map((s) => s.seat)).toEqual(["@dev/1"])
  })

  test("fleet.exec requires command; dry-run forwards flags", async () => {
    const calls: string[][] = []
    const tools = fleetTools({
      projectRoot: "/repo",
      run: (args) => {
        calls.push([...args])
        return {
          status: 0,
          stdout: JSON.stringify({ command: "hi", rows: [] }),
          stderr: "",
        }
      },
    })
    const exec = tools.find((t) => t.name === "fleet.exec")!
    await expect(exec.handler({}, {})).rejects.toThrow(/non-empty command/)
    await exec.handler({ command: "hi", seats: "@dev/1", dryRun: true }, {})
    expect(calls[0]).toContain("fleet-exec")
    expect(calls[0]).toContain("--dry-run")
    expect(calls[0]).toContain("--json")
    expect(calls[0]).toContain("hi")
  })

  test("fleet.wake applies --apply --notify when requested", async () => {
    const calls: string[][] = []
    const tools = fleetTools({
      projectRoot: "/repo",
      run: (args) => {
        calls.push([...args])
        return { status: 0, stdout: JSON.stringify({ plan: { rows: [] } }), stderr: "" }
      },
    })
    const wake = tools.find((t) => t.name === "fleet.wake")!
    await wake.handler({ apply: true, notify: true, protect: "@dev/9" }, {})
    expect(calls[0]).toEqual(["fleet-wake", "--json", "--apply", "--notify", "--protect", "@dev/9"])
  })

  test("missing JSON fails loud", async () => {
    const tools = fleetTools({
      projectRoot: "/repo",
      run: () => ({ status: 1, stdout: "", stderr: "herdr down" }),
    })
    const read = tools.find((t) => t.name === "fleet.read")!
    await expect(read.handler({}, {})).rejects.toThrow(/herdr down|failed/)
  })
})
