/**
 * @failure An env-backed daemon default silently stops being read, so a documented knob is
 *          passed, logged and ignored — or a renamed flag silently drops its field alias.
 * @level   l1
 * @consumer withConfig — the daemon's only config resolution point
 *
 * Written 2026-08-11 after TRIBE_QUIT_TIMEOUT turned out to be fictional. hab set it on the
 * wire service, it reached the daemon's environment, its own log line and docstring named it as
 * the knob — and `quit-timeout` defaulted to the literal "1800", so nothing read it. The fleet
 * ran a 30-minute idle timeout for hours while every surface said six.
 *
 * A config that is documented, passed, and ignored is worse than one that does not exist,
 * because every reader believes it works. None of the env-backed defaults had a test; that is
 * why this survived. All of them are covered here, not just the one that broke.
 *
 * Extended 2026-08-12 for the `--quit-timeout` → `--idle-quit-after` rename: the deprecated
 * alias must keep parsing (field supervise.json still passes `--quit-timeout -1`), `never`
 * must map to -1, and hab-supervised daemons (HAB_SERVICE_NAME) must default to never while
 * standalone daemons keep 1800s.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { parseIdleQuitAfterSec, resolveIdleQuit, withConfig } from "./with-config.ts"

const ENV_KEYS = [
  "TRIBE_AUTOQUIT_ON_IDLE",
  "HAB_SERVICE_NAME",
  "TRIBE_FOCUS_POLL_MS",
  "TRIBE_SUMMARY_POLL_MS",
  "TRIBE_SUMMARIZER_MODEL",
] as const

const saved = new Map<string, string | undefined>()

beforeEach(() => {
  // Deprecated-flag specimens intentionally prove the operator warning path.
  vi.spyOn(console, "warn").mockImplementation(() => {})
})
function setEnv(key: string, value: string | undefined): void {
  if (!saved.has(key)) saved.set(key, process.env[key])
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  saved.clear()
})

/** withConfig only needs a base object to spread; nothing here touches the rest of the tribe. */
const resolve = (argv: string[] = []) => withConfig({ argv })({} as never).config

/** The idle-quit surfaces leak in from the runner's real environment (a test
 * run under hab would flip the default) — pin them off unless a test sets them. */
function clearIdleQuitEnv(): void {
  setEnv("TRIBE_AUTOQUIT_ON_IDLE", undefined)
  setEnv("HAB_SERVICE_NAME", undefined)
}

describe("withConfig env-backed defaults", () => {
  test("TRIBE_AUTOQUIT_ON_IDLE sets the idle quit timeout", () => {
    clearIdleQuitEnv()
    setEnv("TRIBE_AUTOQUIT_ON_IDLE", "21600")
    expect(resolve().idleQuitAfterSec).toBe(21600)
    expect(resolve().idleQuitSource).toBe("env")
  })

  test("TRIBE_AUTOQUIT_ON_IDLE=-1 reaches the config as -1, which disables auto-quit", () => {
    clearIdleQuitEnv()
    setEnv("TRIBE_AUTOQUIT_ON_IDLE", "-1")
    // with-idle-quit treats < 0 as "never fire". The value must survive parsing to get there.
    expect(resolve().idleQuitAfterSec).toBe(-1)
  })

  test("absent env falls back to the 1800s standalone default", () => {
    clearIdleQuitEnv()
    const config = resolve()
    expect(config.idleQuitAfterSec).toBe(1800)
    expect(config.idleQuitSource).toBe("default")
  })

  test("an explicit --idle-quit-after flag beats the env", () => {
    clearIdleQuitEnv()
    setEnv("TRIBE_AUTOQUIT_ON_IDLE", "21600")
    const config = resolve(["--idle-quit-after", "45"])
    expect(config.idleQuitAfterSec).toBe(45)
    expect(config.idleQuitSource).toBe("flag")
  })

  test("every other env-backed default is read too — the same silence would hide any of them", () => {
    setEnv("TRIBE_FOCUS_POLL_MS", "12345")
    setEnv("TRIBE_SUMMARY_POLL_MS", "23456")
    const config = resolve()
    expect(config.focusPollMs).toBe(12345)
    expect(config.summaryPollMs).toBe(23456)
  })
})

describe("--idle-quit-after value forms", () => {
  test.each([
    ["never", -1],
    ["NEVER", -1],
    ["-1", -1],
    ["0", 0],
    ["1800", 1800],
    ["90s", 90],
    ["30m", 1800],
    ["6h", 21600],
  ])("%s parses to %d seconds", (raw, seconds) => {
    clearIdleQuitEnv()
    expect(resolve(["--idle-quit-after", raw]).idleQuitAfterSec).toBe(seconds)
  })

  test("garbage throws loudly instead of becoming NaN and silently never quitting", () => {
    // parseInt("20 minutes") would yield 20; parseInt("soon") NaN — NaN poisons every
    // deadline comparison into false, i.e. a daemon that never quits with no record of
    // deciding that. The boundary must reject, not coerce.
    for (const bad of ["soon", "20 minutes", "1.5h", "h", ""]) {
      expect(() => parseIdleQuitAfterSec(bad, "--idle-quit-after")).toThrowError(/--idle-quit-after must be/)
    }
  })
})

describe("--quit-timeout deprecated alias", () => {
  test("still parses — field supervise.json passes `--quit-timeout -1`", () => {
    clearIdleQuitEnv()
    const config = resolve(["--quit-timeout", "-1"])
    expect(config.idleQuitAfterSec).toBe(-1)
    expect(config.idleQuitSource).toBe("deprecated-flag")
  })

  test("plain seconds keep their historical meaning", () => {
    clearIdleQuitEnv()
    expect(resolve(["--quit-timeout", "45"]).idleQuitAfterSec).toBe(45)
  })

  test("the canonical flag wins when both are passed", () => {
    clearIdleQuitEnv()
    const config = resolve(["--quit-timeout", "45", "--idle-quit-after", "never"])
    expect(config.idleQuitAfterSec).toBe(-1)
    expect(config.idleQuitSource).toBe("flag")
  })

  test("the deprecated alias still beats the env — it is a flag, not a fallback", () => {
    clearIdleQuitEnv()
    setEnv("TRIBE_AUTOQUIT_ON_IDLE", "21600")
    expect(resolve(["--quit-timeout", "45"]).idleQuitAfterSec).toBe(45)
  })
})

describe("hab-managed default (HAB_SERVICE_NAME)", () => {
  test("a hab-supervised daemon with no explicit knob never idle-quits", () => {
    // The 2026-08-11/12 outages: a seat-relaunch sweep empties every connection at once,
    // indistinguishable from idleness, and hab counts the clean exit as a service failure.
    clearIdleQuitEnv()
    setEnv("HAB_SERVICE_NAME", "wire")
    const config = resolve()
    expect(config.idleQuitAfterSec).toBe(-1)
    expect(config.idleQuitSource).toBe("hab-managed")
  })

  test("standalone daemons (no HAB_SERVICE_NAME) keep the 1800s default", () => {
    clearIdleQuitEnv()
    expect(resolve().idleQuitAfterSec).toBe(1800)
  })

  test("an explicit flag beats the hab-managed default", () => {
    clearIdleQuitEnv()
    setEnv("HAB_SERVICE_NAME", "wire")
    expect(resolve(["--idle-quit-after", "6h"]).idleQuitAfterSec).toBe(21600)
  })

  test("an explicit env beats the hab-managed default", () => {
    clearIdleQuitEnv()
    setEnv("HAB_SERVICE_NAME", "wire")
    setEnv("TRIBE_AUTOQUIT_ON_IDLE", "900")
    const config = resolve()
    expect(config.idleQuitAfterSec).toBe(900)
    expect(config.idleQuitSource).toBe("env")
  })

  test("a blank HAB_SERVICE_NAME is not a hab context", () => {
    clearIdleQuitEnv()
    setEnv("HAB_SERVICE_NAME", "  ")
    expect(resolve().idleQuitAfterSec).toBe(1800)
  })
})

describe("resolveIdleQuit (pure)", () => {
  test("resolution order: flag > deprecated flag > env > hab-managed > default", () => {
    const env = { TRIBE_AUTOQUIT_ON_IDLE: "900", HAB_SERVICE_NAME: "wire" }
    expect(resolveIdleQuit({ idleQuitAfter: "never", quitTimeout: "45", env })).toEqual({
      idleQuitAfterSec: -1,
      idleQuitSource: "flag",
    })
    expect(resolveIdleQuit({ quitTimeout: "45", env })).toEqual({
      idleQuitAfterSec: 45,
      idleQuitSource: "deprecated-flag",
    })
    expect(resolveIdleQuit({ env })).toEqual({ idleQuitAfterSec: 900, idleQuitSource: "env" })
    expect(resolveIdleQuit({ env: { HAB_SERVICE_NAME: "wire" } })).toEqual({
      idleQuitAfterSec: -1,
      idleQuitSource: "hab-managed",
    })
    expect(resolveIdleQuit({ env: {} })).toEqual({ idleQuitAfterSec: 1800, idleQuitSource: "default" })
  })
})
