/**
 * @failure A Hab-supervised Tribe daemon handles SIGHUP by detached-spawning
 *          its successor, escaping the supervisor that owns restart policy.
 * @level   l0
 * @consumer @ag/tribe/22322-daemon-restart-drops-bridges-with-no-repair-verb
 */

import { EventEmitter } from "node:events"
import { describe, expect, it, vi } from "vitest"
import { reloadReplacementForEnvironment, withHotReload } from "./with-hot-reload.ts"

const { spawnStandaloneDaemonSupervisor } = vi.hoisted(() => ({
  spawnStandaloneDaemonSupervisor: vi.fn(),
}))

vi.mock("tribe-wire", () => ({ spawnStandaloneDaemonSupervisor }))

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

  it("keeps the current socket alive when a standalone owner cannot start", () => {
    const stopPlugins = vi.fn()
    const triggerShutdown = vi.fn()
    const healthLog = vi.fn()
    const close = vi.fn()
    const socket = {
      handedOff: false,
      server: { close },
      socketPath: "/must-not-unlink-owner-start-failure.sock",
    }
    spawnStandaloneDaemonSupervisor.mockImplementationOnce(() => {
      throw new Error("owner startup failed")
    })
    const subject = withHotReload({
      stopPlugins,
      triggerShutdown,
      disableWatch: true,
    })({ broadcast: { log: healthLog }, config: { operatorCapability: null }, socket } as never)

    expect(() => subject.hotReload.reload()).toThrow("owner startup failed")

    expect(healthLog).toHaveBeenCalledWith(
      "tribe:hot-reload: Hot-reload lifecycle owner failed to start: owner startup failed",
      "health:daemon:error",
    )
    expect(stopPlugins).not.toHaveBeenCalled()
    expect(socket.handedOff).toBe(false)
    expect(close).not.toHaveBeenCalled()
    expect(triggerShutdown).not.toHaveBeenCalled()
  })

  it("keeps the current socket alive when a standalone owner exits during startup", () => {
    vi.useFakeTimers()
    try {
      const stopPlugins = vi.fn()
      const triggerShutdown = vi.fn()
      const healthLog = vi.fn()
      const close = vi.fn()
      const socket = {
        handedOff: false,
        server: { close },
        socketPath: "/must-not-unlink-owner-early-exit.sock",
      }
      const owner = new EventEmitter()
      spawnStandaloneDaemonSupervisor.mockReturnValueOnce(owner as never)
      const subject = withHotReload({
        stopPlugins,
        triggerShutdown,
        disableWatch: true,
      })({ broadcast: { log: healthLog }, config: { operatorCapability: null }, socket } as never)

      subject.hotReload.reload()
      owner.emit("exit", 1, null)
      vi.advanceTimersByTime(1000)

      expect(healthLog).toHaveBeenCalledWith(
        "tribe:hot-reload: Hot-reload lifecycle owner exited before handoff (code=1, signal=null)",
        "health:daemon:error",
      )
      expect(stopPlugins).not.toHaveBeenCalled()
      expect(socket.handedOff).toBe(false)
      expect(close).not.toHaveBeenCalled()
      expect(triggerShutdown).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it("reports and rethrows a supervised replacement failure", () => {
    const healthLog = vi.fn()
    const subject = withHotReload({
      stopPlugins: vi.fn(),
      replaceProcess() {
        throw new Error("owner handoff failed")
      },
      triggerShutdown: vi.fn(),
      disableWatch: true,
    })({
      broadcast: { log: healthLog },
      config: { operatorCapability: null },
      socket: {
        handedOff: false,
        server: { close: vi.fn() },
        socketPath: "/must-not-unlink-supervised-failure.sock",
      },
    } as never)

    expect(() => subject.hotReload.reload()).toThrow("owner handoff failed")
    expect(healthLog).toHaveBeenCalledWith(
      "tribe:hot-reload: Hot-reload lifecycle owner replacement failed: owner handoff failed",
      "health:daemon:error",
    )
  })

  it("selects replacement for Hab and the daemon's actual standalone supervisor", () => {
    const shutdown = vi.fn()

    const supervised = reloadReplacementForEnvironment({ HAB_SERVICE_KIND: "service" }, shutdown)
    expect(supervised).toBeTypeOf("function")
    supervised?.("operator requested reload")
    expect(shutdown).toHaveBeenCalledOnce()

    expect(reloadReplacementForEnvironment({}, shutdown)).toBeUndefined()
    expect(reloadReplacementForEnvironment({ HAB_SERVICE_KIND: "watcher" }, shutdown)).toBeUndefined()

    const previousExitCode = process.exitCode
    try {
      const standalone = reloadReplacementForEnvironment(
        {
          TRIBE_DAEMON_RELOAD_EXIT_CODE: "75",
          TRIBE_DAEMON_SUPERVISOR_PID: "4242",
        },
        shutdown,
        4242,
      )
      expect(standalone).toBeTypeOf("function")
      standalone?.("operator requested reload")
      expect(process.exitCode).toBe(75)
      expect(shutdown).toHaveBeenCalledTimes(2)

      expect(
        reloadReplacementForEnvironment(
          {
            TRIBE_DAEMON_RELOAD_EXIT_CODE: "75",
            TRIBE_DAEMON_SUPERVISOR_PID: "4242",
          },
          shutdown,
          9999,
        ),
      ).toBeUndefined()
    } finally {
      process.exitCode = previousExitCode
    }
  })
})
