/**
 * @failure A Hab-supervised Tribe daemon handles SIGHUP by detached-spawning
 *          its successor, escaping the supervisor that owns restart policy.
 * @level   l0
 * @consumer @ag/tribe/22322-daemon-restart-drops-bridges-with-no-repair-verb
 */

import { describe, expect, it, vi } from "vitest"
import { reloadReplacementForEnvironment, withHotReload } from "./with-hot-reload.ts"

describe("daemon reload lifecycle ownership", () => {
  it("delegates replacement without mutating the socket when a supervisor owns the daemon", () => {
    const stopPlugins = vi.fn()
    const replaceProcess = vi.fn()
    const triggerShutdown = vi.fn()
    const close = vi.fn()
    const socket = {
      handedOff: false,
      server: { close },
      socketPath: "/must-not-unlink-supervised-tribe.sock",
    }
    const subject = withHotReload({
      stopPlugins,
      replaceProcess,
      triggerShutdown,
      disableWatch: true,
    })({ config: { operatorCapability: null }, socket } as never)

    subject.hotReload.reload()

    expect(stopPlugins).toHaveBeenCalledOnce()
    expect(replaceProcess).toHaveBeenCalledWith("SIGHUP received — re-exec for hot-reload")
    expect(socket.handedOff).toBe(false)
    expect(close).not.toHaveBeenCalled()
    expect(triggerShutdown).not.toHaveBeenCalled()
  })

  it("selects supervisor replacement only for a Hab service process", () => {
    const shutdown = vi.fn()

    const supervised = reloadReplacementForEnvironment({ HAB_SERVICE_KIND: "service" }, shutdown)
    expect(supervised).toBeTypeOf("function")
    supervised?.("operator requested reload")
    expect(shutdown).toHaveBeenCalledOnce()

    expect(reloadReplacementForEnvironment({}, shutdown)).toBeUndefined()
    expect(reloadReplacementForEnvironment({ HAB_SERVICE_KIND: "watcher" }, shutdown)).toBeUndefined()
  })
})
