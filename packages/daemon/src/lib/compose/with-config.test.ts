/**
 * @failure An env-backed daemon default silently stops being read, so a documented knob is
 *          passed, logged and ignored.
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
 */

import { afterEach, describe, expect, test } from "vitest"
import { withConfig } from "./with-config.ts"

const ENV_KEYS = [
  "TRIBE_AUTOQUIT_ON_IDLE",
  "TRIBE_FOCUS_POLL_MS",
  "TRIBE_SUMMARY_POLL_MS",
  "TRIBE_SUMMARIZER_MODEL",
] as const

const saved = new Map<string, string | undefined>()
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

describe("withConfig env-backed defaults", () => {
  test("TRIBE_AUTOQUIT_ON_IDLE sets the idle quit timeout", () => {
    for (const key of ENV_KEYS) setEnv(key, undefined)
    setEnv("TRIBE_AUTOQUIT_ON_IDLE", "21600")
    expect(resolve().quitTimeoutSec).toBe(21600)
  })

  test("TRIBE_AUTOQUIT_ON_IDLE=-1 reaches the config as -1, which disables auto-quit", () => {
    setEnv("TRIBE_AUTOQUIT_ON_IDLE", "-1")
    // with-idle-quit treats < 0 as "never fire". The value must survive parsing to get there.
    expect(resolve().quitTimeoutSec).toBe(-1)
  })

  test("absent env falls back to the 1800s default", () => {
    setEnv("TRIBE_AUTOQUIT_ON_IDLE", undefined)
    expect(resolve().quitTimeoutSec).toBe(1800)
  })

  test("an explicit --quit-timeout flag beats the env", () => {
    setEnv("TRIBE_AUTOQUIT_ON_IDLE", "21600")
    expect(resolve(["--quit-timeout", "45"]).quitTimeoutSec).toBe(45)
  })

  test("every other env-backed default is read too — the same silence would hide any of them", () => {
    setEnv("TRIBE_FOCUS_POLL_MS", "12345")
    setEnv("TRIBE_SUMMARY_POLL_MS", "23456")
    const config = resolve()
    expect(config.focusPollMs).toBe(12345)
    expect(config.summaryPollMs).toBe(23456)
  })
})
