/**
 * @failure Accountly used launch PATH for Ag, so a shared-main update changed the child before promotion.
 * @level l2 — the plugin poll resolves a real fixture promotion pointer and records its spawn argv.
 * @consumer The supervised Wire accountly plugin.
 * @testonly none
 */
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { safeRemoveSync } from "removely"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import type { TribeClientApi } from "./plugin-api.ts"

const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn() }))
vi.mock("loggily", () => ({ createLogger: () => logger }))

import { accountlyPlugin } from "./accountly-plugin.ts"

const originalHabCli = process.env.HAB_CLI_BIN

beforeEach(() => {
  vi.useFakeTimers()
  logger.info.mockClear()
  logger.warn.mockClear()
  logger.debug.mockClear()
})

afterEach(() => {
  if (originalHabCli === undefined) delete process.env.HAB_CLI_BIN
  else process.env.HAB_CLI_BIN = originalHabCli
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function executable(path: string, text: string): void {
  writeFileSync(path, text)
  chmodSync(path, 0o755)
}

function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "accountly-promotion-"))
  const mainBin = join(root, "shared-main", "node_modules", ".bin")
  const releaseABin = join(root, "release-a", "node_modules", ".bin")
  const releaseBBin = join(root, "release-b", "node_modules", ".bin")
  for (const dir of [mainBin, releaseABin, releaseBBin]) mkdirSync(dir, { recursive: true })
  executable(join(mainBin, "ag"), "#!/bin/sh\n# shared-main-v1\n")
  executable(join(releaseABin, "ag"), "#!/bin/sh\n# promoted-a\n")
  executable(join(releaseBBin, "ag"), "#!/bin/sh\n# promoted-b\n")
  executable(join(releaseABin, "hab"), "#!/bin/sh\n")
  executable(join(releaseBBin, "hab"), "#!/bin/sh\n")
  const current = join(root, "current")
  symlinkSync(join(root, "release-a"), current, "dir")
  const pointer = join(current, "node_modules", ".bin", "hab")
  return { root, mainBin, releaseABin, releaseBBin, current, pointer }
}

function pollHarness(mainBin: string) {
  const actualWhich = Bun.which.bind(Bun)
  vi.spyOn(Bun, "which").mockImplementation(((name: string, options?: { PATH?: string }) =>
    actualWhich(name, options ?? { PATH: mainBin })) as typeof Bun.which)
  const spawned: Array<{ argv: string[]; target: string; source: string }> = []
  vi.spyOn(Bun, "spawn").mockImplementation(((argv: string[]) => {
    spawned.push({
      argv: [...argv],
      target: realpathSync(argv[0]!),
      source: readFileSync(realpathSync(argv[0]!), "utf8"),
    })
    return {
      stdout: new Blob(['{"quotas":[]}']).stream(),
      stderr: new Blob([]).stream(),
      exited: Promise.resolve(0),
      exitCode: 0,
    } as ReturnType<typeof Bun.spawn>
  }) as typeof Bun.spawn)
  const api = { claimDedup: vi.fn(() => true), broadcast: vi.fn(), send: vi.fn() } as unknown as TribeClientApi
  return { spawned, api }
}

test("accountly follows the promoted Ag child at each poll, ignoring shared-main changes until promotion", async () => {
  const f = fixture()
  process.env.HAB_CLI_BIN = f.pointer
  const { spawned, api } = pollHarness(f.mainBin)
  const stop = accountlyPlugin.start(api)
  try {
    await vi.advanceTimersByTimeAsync(120_000)
    expect(spawned[0]).toMatchObject({
      argv: [join(dirname(f.pointer), "ag"), "status", "--json"],
      target: join(f.releaseABin, "ag"),
      source: expect.stringContaining("promoted-a"),
    })
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining(JSON.stringify([join(dirname(f.pointer), "ag"), "status", "--json"])),
    )

    executable(join(f.mainBin, "ag"), "#!/bin/sh\n# shared-main-v2\n")
    await vi.advanceTimersByTimeAsync(600_000)
    expect(spawned[1]?.source).toContain("promoted-a")

    symlinkSync(join(f.root, "release-b"), join(f.root, "next-current"), "dir")
    renameSync(join(f.root, "next-current"), f.current)
    await vi.advanceTimersByTimeAsync(600_000)
    expect(spawned[2]).toMatchObject({
      argv: [join(dirname(f.pointer), "ag"), "status", "--json"],
      target: join(f.releaseBBin, "ag"),
      source: expect.stringContaining("promoted-b"),
    })
  } finally {
    if (typeof stop === "function") stop()
    safeRemoveSync(f.root, { within: realpathSync(tmpdir()) })
  }
})

test("accountly names an absent promotion pointer and skips the poll without trying PATH", async () => {
  const f = fixture()
  delete process.env.HAB_CLI_BIN
  const { spawned, api } = pollHarness(f.mainBin)
  const stop = accountlyPlugin.start(api)
  try {
    await vi.advanceTimersByTimeAsync(120_000)
    expect(spawned).toEqual([])
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("HAB_CLI_BIN"))
    expect(api.broadcast).toHaveBeenCalledWith(
      expect.stringContaining("HAB_CLI_BIN"),
      "health:account:error",
      undefined,
      expect.any(Object),
    )
  } finally {
    if (typeof stop === "function") stop()
    safeRemoveSync(f.root, { within: realpathSync(tmpdir()) })
  }
})

test("accountly names a dangling promotion pointer and skips the poll without trying PATH", async () => {
  const f = fixture()
  process.env.HAB_CLI_BIN = join(f.root, "missing-current", "node_modules", ".bin", "hab")
  const { spawned, api } = pollHarness(f.mainBin)
  const stop = accountlyPlugin.start(api)
  try {
    await vi.advanceTimersByTimeAsync(120_000)
    expect(spawned).toEqual([])
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(process.env.HAB_CLI_BIN))
    expect(api.broadcast).toHaveBeenCalledWith(
      expect.stringContaining(process.env.HAB_CLI_BIN),
      "health:account:error",
      undefined,
      expect.any(Object),
    )
  } finally {
    if (typeof stop === "function") stop()
    safeRemoveSync(f.root, { within: realpathSync(tmpdir()) })
  }
})
