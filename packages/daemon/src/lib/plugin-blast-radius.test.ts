/**
 * @failure One optional plugin's refusal took the whole daemon down. On
 *   2026-08-13 `openGitHubCursorStore` correctly refused a conflicting
 *   XDG-vs-legacy cursor state; that throw escaped `githubPlugin.start`,
 *   escaped `loadPlugins`, and the daemon NEVER STARTED — every seat lost
 *   coordination because an OBSERVER plugin could not read a cursor file.
 * @level l0 — pure loader semantics over stub plugins, no I/O.
 * @consumer loadPlugins, called at daemon module scope via withRuntime.
 *
 * The cursor refusal itself is correct and stays. What is fixed here is the
 * blast radius: an optional plugin's failure disables that plugin loudly and
 * visibly, and the daemon serves.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createScope } from "tribe-wire"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createTribeContext } from "./context.ts"
import { createStatements, openDatabase } from "./database.ts"
import { withRuntime } from "./compose/with-runtime.ts"
import { loadPlugins } from "./plugin-loader.ts"
import type { TribeClientApi, TribePluginApi, TribePluginHandle } from "./plugin-api.ts"

/** The loader never touches the api — plugins do. A stub is enough. */
const stubApi = {
  send: () => {},
  broadcast: () => {},
  claimDedup: () => true,
  hasRecentMessage: () => false,
  getActiveSessions: () => [],
  getSessionNames: () => [],
  getUnreadDms: () => ({ count: 0, oldestTs: 0 }),
} satisfies TribeClientApi

/** The real 2026-08-13 message, verbatim in shape. */
const CURSOR_REFUSAL =
  "GitHub cursor open failed after inspecting XDG destination /x/github-cursor.json and legacy source " +
  "/y/.beads/github-cursor.json: adoption changed state while copying the legacy cursor"

beforeEach(() => {
  // Every failure-path specimen below deliberately exercises the loader's
  // loud operator diagnostic. The dedicated logging assertion proves its
  // full cause text; keep the root no-unexpected-console gate focused on
  // output these tests did not intentionally trigger.
  vi.spyOn(console, "error").mockImplementation(() => {})
})

function plugin(name: string, overrides: Partial<TribePluginApi> = {}): TribePluginApi {
  return { name, available: () => true, start: () => () => {}, ...overrides }
}

describe("plugin load blast radius", () => {
  it("keeps the daemon serving when an optional plugin's start() throws", () => {
    const started: string[] = []
    const plugins = [
      plugin("github", {
        start() {
          throw new Error(CURSOR_REFUSAL)
        },
      }),
      plugin("health-monitor", {
        start() {
          started.push("health-monitor")
          return () => {}
        },
      }),
    ]

    // Pre-fix this throws, so the daemon process dies at module scope.
    const loaded = loadPlugins(plugins, stubApi)

    // The daemon serves, and a plugin AFTER the failure still loads — the
    // failure must not truncate the loop either.
    expect(started).toEqual(["health-monitor"])
    expect(loaded.active.filter((p) => p.active).map((p) => p.name)).toEqual(["health-monitor"])
  })

  it("names the failed plugin as disabled and carries its full cause text", () => {
    const loaded = loadPlugins(
      [
        plugin("github", {
          start() {
            throw new Error(CURSOR_REFUSAL)
          },
        }),
      ],
      stubApi,
    )

    const handle = loaded.active.find((p) => p.name === "github")
    expect(handle).toBeDefined()
    expect(handle?.active).toBe(false)
    // Disabled-by-failure must be distinguishable from disabled-by-unavailable:
    // the absence is a NAMED state, never a silent one.
    expect(handle?.error).toContain("adoption changed state while copying the legacy cursor")
    expect(handle?.error).toContain("XDG destination")
  })

  it("logs the actual cause text, not a summary", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      loadPlugins(
        [
          plugin("github", {
            start() {
              throw new Error(CURSOR_REFUSAL)
            },
          }),
        ],
        stubApi,
      )
      const logged = errorSpy.mock.calls.map((call) => call.join(" ")).join("\n")
      expect(logged).toContain("github")
      expect(logged).toContain("adoption changed state while copying the legacy cursor")
    } finally {
      errorSpy.mockRestore()
    }
  })

  it("contains a throw from available() the same way as one from start()", () => {
    const loaded = loadPlugins(
      [
        plugin("accountly", {
          available() {
            throw new Error("accountly config unreadable")
          },
        }),
        plugin("git"),
      ],
      stubApi,
    )

    expect(loaded.active.find((p) => p.name === "accountly")?.error).toContain("accountly config unreadable")
    expect(loaded.active.find((p) => p.name === "git")?.active).toBe(true)
  })

  it("leaves an unavailable plugin disabled WITHOUT an error — absent is not failed", () => {
    const loaded = loadPlugins([plugin("github", { available: () => false })], stubApi)

    const handle = loaded.active.find((p) => p.name === "github")
    expect(handle?.active).toBe(false)
    expect(handle?.error).toBeUndefined()
  })

  it("stays fatal when a plugin declares itself load-bearing", () => {
    const plugins = [plugin("core-rail", { loadBearing: true, start: () => void reject() })]
    function reject(): never {
      throw new Error("core rail cannot start")
    }

    expect(() => loadPlugins(plugins, stubApi)).toThrow(/core rail cannot start/)
  })

  it("stops already-started plugins before a load-bearing failure propagates", () => {
    const stopped: string[] = []
    const plugins = [
      plugin("git", {
        start() {
          return () => stopped.push("git")
        },
      }),
      plugin("core-rail", {
        loadBearing: true,
        start() {
          throw new Error("core rail cannot start")
        },
      }),
    ]

    expect(() => loadPlugins(plugins, stubApi)).toThrow(/core rail cannot start/)
    // Otherwise the fatal path leaks the timers/watchers the earlier plugins opened.
    expect(stopped).toEqual(["git"])
  })

  it("still stops the healthy plugins that loaded alongside a failed one", () => {
    const stopped: string[] = []
    const loaded = loadPlugins(
      [
        plugin("github", {
          start() {
            throw new Error(CURSOR_REFUSAL)
          },
        }),
        plugin("git", {
          start() {
            return () => stopped.push("git")
          },
        }),
      ],
      stubApi,
    )

    loaded.stop()
    expect(stopped).toEqual(["git"])
  })
})

/**
 * The loader can contain a failure perfectly and the daemon still be silent
 * about it if nothing carries the outcome to a surface an operator reads.
 * withRuntime is that bridge.
 */
describe("a disabled plugin reaches the status surface", () => {
  it("publishes the failed plugin's handle, not just the active names", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plugin-status-"))
    const db = openDatabase(join(tmpDir, "tribe.db"))
    const stmts = createStatements(db)
    const scope = createScope("plugin-status-test")

    let publishedNames: string[] = []
    let publishedStatus: TribePluginHandle[] = []

    try {
      const shape = {
        scope,
        daemonSessionId: "daemon",
        startedAt: Date.now(),
        daemonVersion: "test",
        daemonPid: process.pid,
        config: {},
        db,
        stmts,
        daemonCtx: createTribeContext({
          db,
          stmts,
          sessionId: "daemon",
          sessionRole: "member",
          initialName: "daemon",
          domains: [],
          claudeSessionId: null,
          claudeSessionName: null,
        }),
        recall: null,
        registry: {
          clients: new Map(),
          socketToClient: new Map(),
          getActiveSessionIds: () => new Set<string>(),
          getActiveSessionInfo: () => [],
          hasActiveTransport: () => false,
          isReconnectGraceProtected: () => false,
          startupReconnectGraceRemainingMs: () => 0,
          forgetTransportSessions: vi.fn(),
          onTransportDisconnected: vi.fn(),
        },
        broadcast: {},
        socket: {},
      }

      withRuntime({
        plugins: [
          plugin("github", {
            start() {
              throw new Error(CURSOR_REFUSAL)
            },
          }),
          plugin("git"),
        ],
        buildPluginApi: () => ({}) as never,
        cleanupIntervalMs: 10_000_000,
        publishActivePluginNames: (names) => {
          publishedNames = names
        },
        publishPluginStatus: (handles) => {
          publishedStatus = handles
        },
        publishStopPlugins: () => {},
        publishShutdown: () => {},
      })(shape as never)

      // The names list alone cannot express "github failed" — it can only omit
      // github, which reads identically to github never being configured.
      expect(publishedNames).toEqual(["git"])

      const github = publishedStatus.find((p) => p.name === "github")
      expect(github?.active).toBe(false)
      expect(github?.error).toContain("adoption changed state while copying the legacy cursor")
    } finally {
      await scope[Symbol.asyncDispose]()
      db.close()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
