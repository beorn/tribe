/**
 * Plugin loader — starts each available plugin with a shared TribeClientApi
 * and returns a combined stop function.
 *
 * Plugins that report `!available()` are recorded inactive and skipped
 * (dependency missing — e.g. no gh auth or account configuration).
 *
 * Blast radius (2026-08-13): a plugin is an OBSERVER, and the daemon's
 * coordination core does not depend on any of them — a daemon with zero
 * plugins is a complete coordination server. So a plugin that throws while
 * loading disables ITSELF, loudly, and the daemon serves. It took an outage to
 * pay for this: `githubPlugin.start` correctly refused a conflicting
 * XDG-vs-legacy cursor state, the throw escaped this loop, and the daemon never
 * started — the whole fleet lost coordination because one optional observer
 * could not read a cursor file.
 *
 * A failure is never silent: it is logged with the cause verbatim and the
 * plugin is reported `active: false` WITH an `error`, which is a different
 * state from the `active: false` of a plugin that was merely unavailable.
 *
 * A plugin that genuinely cannot be absent sets `loadBearing` and keeps the
 * old fatal semantics.
 */

import { createLogger } from "loggily"
import type { TribePluginApi, TribeClientApi, TribePluginHandle } from "./plugin-api.ts"

const log = createLogger("tribe:plugins")

export interface LoadedPlugins {
  /** Plugin identity snapshot (for observability — e.g. /cli_status "resources"). */
  active: TribePluginHandle[]
  /** Stop every started plugin. */
  stop(): void
}

/** Full cause text — message plus stack, so the log names the throwing line. */
function describeFailure(error: unknown): string {
  if (error instanceof Error) return error.stack ? `${error.message}\n${error.stack}` : error.message
  return String(error)
}

export function loadPlugins(plugins: TribePluginApi[], api: TribeClientApi): LoadedPlugins {
  const cleanups: Array<() => void> = []
  const active: TribePluginHandle[] = []
  const stopAll = () => {
    for (const fn of cleanups) fn()
  }

  for (const plugin of plugins) {
    try {
      const isAvailable = plugin.available()
      if (!isAvailable) {
        active.push({ name: plugin.name, active: false })
        log.info?.(`plugin ${plugin.name}: not available (skipped)`)
        continue
      }
      const cleanup = plugin.start(api)
      active.push({ name: plugin.name, active: true })
      log.info?.(`plugin ${plugin.name}: active`)
      if (cleanup) cleanups.push(cleanup)
    } catch (error) {
      const cause = describeFailure(error)
      if (plugin.loadBearing) {
        // Declared load-bearing — the daemon must not serve without it. Release
        // what already started so the fatal path does not leak their timers and
        // watchers, then let the throw reach the caller unchanged.
        log.error?.(`plugin ${plugin.name}: LOAD-BEARING plugin failed to start — daemon cannot serve: ${cause}`)
        stopAll()
        throw error
      }
      log.error?.(
        `plugin ${plugin.name}: DISABLED — failed to start, daemon continues without it. ` +
          `Coordination is unaffected; this plugin's signals are not being observed. Cause: ${cause}`,
      )
      active.push({ name: plugin.name, active: false, error: cause })
    }
  }

  return { active, stop: stopAll }
}
