/**
 * @failure  The source says nothing about WHICH hab it spawns per call, so a promotion that moves the landing's
 *           hab underneath a long-lived daemon is invisible until a reader is already broken. That is the 28657
 *           incident: the wire daemon spawned a launch-baked `hab` by NAME, outside its import-graph digest, the
 *           controller correctly skipped its restart as `measured-equivalent`, and the reader stayed on an
 *           abandoned journal for hours with nothing on the wire saying which hab it had spawned (@cto ed3c07a4).
 * @level    l1 - the one startup line, through the real loggily boundary
 * @consumer @ag/hab/25497-a-resident-controller-runs-the-landing-it-started-on-for-hours-after-a-merge/28657
 * @testonly none
 */
import { expect, test, vi } from "vitest"
import { fileURLToPath } from "node:url"

const logs = vi.hoisted(() => [] as Array<{ ns: string; level: string; msg: unknown; data: unknown }>)

vi.mock("loggily", async (original) => {
  const actual = await original<typeof import("loggily")>()
  const logger = (ns: string) => ({
    info: (msg: unknown, data: unknown) => logs.push({ ns, level: "info", msg, data }),
    warn: (msg: unknown, data: unknown) => logs.push({ ns, level: "warn", msg, data }),
    error: (msg: unknown, data: unknown) => logs.push({ ns, level: "error", msg, data }),
    debug: () => {},
    child: () => logger(ns),
  })
  return { ...actual, createLogger: (ns: string) => logger(ns) }
})

const LINE = "health process source: the hab it spawns per call"

/** A fresh module instance per test: the announcement is deliberately ONCE per process, so a shared registry would
 *  silence the second case (@testonly `vi.resetModules`, not a hole in the rule being tested). */
async function freshSource(env: Record<string, string>): Promise<void> {
  logs.length = 0
  vi.resetModules()
  const { createHealthProcessSource } = await import("./health-process-source.ts")
  const source = createHealthProcessSource({
    env: { HAB_SERVICE_NAME: "wire", HAB_SESSION_DIR: "/hab/tribe", ...env },
    runCommand: vi.fn(),
  })
  expect(source.kind, "this line is the managed source's").toBe("managed")
}

test("an UNSET HAB_CLI_BIN is announced at WARN — a landings habitat falling back to PATH's hab is the incident's signature", async () => {
  await freshSource({})

  const announced = logs.filter((row) => row.ns === "tribe:health:process-source")
  expect(announced, "an unannounced spawn is what made 28657 take hours to find").toHaveLength(1)
  expect(announced[0]?.msg).toBe(LINE)
  // The VALUE is what an operator reads to tell a landing-spawn from a PATH-spawn; the unset case must SAY that the
  // fallback was taken rather than leave it to be inferred from silence. WARN, not info: an info line can be
  // filtered away, and unset is exactly the reading this incident had (@cto 28657, N2).
  expect(announced[0]?.level).toBe("warn")
  expect(announced[0]?.data).toEqual({ hab: "PATH hab (HAB_CLI_BIN unset)" })
})

test("an INJECTED HAB_CLI_BIN is announced at INFO, naming the pointer it will spawn", async () => {
  const pointer = fileURLToPath(import.meta.url)
  await freshSource({ HAB_CLI_BIN: pointer })

  const announced = logs.filter((row) => row.ns === "tribe:health:process-source")
  expect(announced).toHaveLength(1)
  expect(announced[0]?.level).toBe("info")
  expect(announced[0]?.data).toEqual({ hab: `HAB_CLI_BIN ${pointer}` })
})
