/**
 * @failure A directly launched Tribe daemon inherits an agent session's
 *          identity/capability, or a Hab-owned daemon requires a config-sized
 *          list of empty environment overrides to prevent that leak.
 * @level   l0
 * @consumer root hab.yml wire service
 */

import { closeSync, openSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"
import tribeProject from "../../../hab.projects.ts"
import { sanitizeDaemonProcessEnvironment, sanitizeStandaloneDaemonEnvironment } from "../src/daemon-environment.ts"
import { readSelfMailboxAuthorityFromEnvironment } from "../src/lib/self-mailbox-authority.ts"

const ambientIdentity = {
  TRIBE_ACCOUNT: "worker@example.test",
  TRIBE_DOMAINS: "runtime",
  TRIBE_LAUNCH_ID: "launch-7",
  TRIBE_NAME: "@dev/7",
  TRIBE_PLUGIN_ADAPTER_CHILD: "1",
  TRIBE_PLUGIN_PROVIDER_PARENT_PID: "700",
  TRIBE_PLUGIN_REEXEC_EXIT_CODE: "75",
  TRIBE_PLUGIN_RESUME_JOINED: "1",
  TRIBE_PROVIDER: "codex",
  TRIBE_ROLE: "worker",
  AG_SESSION_AUTH: "a".repeat(43),
  TRIBE_SESSION_NAME: "@dev/7",
  TRIBE_SLA_ROLE: "worker",
  TRIBE_TAKEOVER: "1",
} as const

describe("Tribe daemon environment ownership", () => {
  test("the portable Hab declaration names the accountable owner", () => {
    expect(tribeProject.services.wire.owner).toBe("@chief")
  })

  test("a Hab-owned daemon deletes ambient seat identity and capability in place", () => {
    const env: NodeJS.ProcessEnv = {
      ...ambientIdentity,
      HAB_SERVICE_KIND: "service",
      PATH: "/bin",
      TRIBE_DAEMON_RELOAD_EXIT_CODE: "75",
      TRIBE_DAEMON_SUPERVISOR_PID: "999",
      TRIBE_DELIVERY_FALLBACKS: '[{"prefix":"@dev/","to":"@dev"}]',
      TRIBE_OPERATOR_CAPABILITY: "must-not-cross-env",
      TRIBE_OPERATOR_CAPABILITY_FD: "3",
      TRIBE_SOCKET: "/tmp/tribe.sock",
    }

    expect(sanitizeDaemonProcessEnvironment(env, 999)).toBe(env)
    expect(env).toEqual({
      HAB_SERVICE_KIND: "service",
      PATH: "/bin",
      TRIBE_DELIVERY_FALLBACKS: '[{"prefix":"@dev/","to":"@dev"}]',
      TRIBE_SOCKET: "/tmp/tribe.sock",
    })
  })

  test("standalone pre-spawn sanitation also drops stale lifecycle ownership", () => {
    // HAB_SERVICE_NAME must drop with its siblings: it selects the hab-managed
    // never-idle-quit default, and a standalone daemon minted from a hab seat
    // must keep the standalone 30m default instead of never retiring.
    expect(
      sanitizeStandaloneDaemonEnvironment({
        ...ambientIdentity,
        HAB_SERVICE_KIND: "service",
        HAB_SERVICE_NAME: "wire",
        HAB_SESSION_DIR: "/hab/@dev-3",
        PATH: "/bin",
        TRIBE_DAEMON_RELOAD_EXIT_CODE: "75",
        TRIBE_DAEMON_SUPERVISOR_PID: "123",
        TRIBE_DELIVERY_FALLBACKS: '[{"name":"@fleet","to":"@chief","action":"refuse"}]',
        TRIBE_OPERATOR_CAPABILITY: "must-not-cross-env",
        TRIBE_OPERATOR_CAPABILITY_FD: "3",
        TRIBE_SOCKET: "/tmp/tribe.sock",
      }),
    ).toEqual({
      PATH: "/bin",
      TRIBE_DELIVERY_FALLBACKS: '[{"name":"@fleet","to":"@chief","action":"refuse"}]',
      TRIBE_SOCKET: "/tmp/tribe.sock",
    })
  })

  test("a standalone generation keeps its supervisor-provided capability fd", () => {
    const env: NodeJS.ProcessEnv = {
      ...ambientIdentity,
      TRIBE_DAEMON_RELOAD_EXIT_CODE: "75",
      TRIBE_DAEMON_SUPERVISOR_PID: "123",
      TRIBE_OPERATOR_CAPABILITY_FD: "3",
    }

    sanitizeDaemonProcessEnvironment(env, 123)

    expect(env).toEqual({
      TRIBE_DAEMON_RELOAD_EXIT_CODE: "75",
      TRIBE_DAEMON_SUPERVISOR_PID: "123",
      TRIBE_OPERATOR_CAPABILITY_FD: "3",
    })
  })

  test("a direct daemon preserves an explicitly inherited capability fd while deleting ambient seat identity", () => {
    const capabilityFd = openSync(fileURLToPath(import.meta.url), "r")
    try {
      const env: NodeJS.ProcessEnv = {
        ...ambientIdentity,
        PATH: "/bin",
        TRIBE_OPERATOR_CAPABILITY_FD: String(capabilityFd),
      }

      sanitizeDaemonProcessEnvironment(env, 999)

      expect(env).toEqual({
        PATH: "/bin",
        TRIBE_OPERATOR_CAPABILITY_FD: String(capabilityFd),
      })
    } finally {
      closeSync(capabilityFd)
    }
  })

  test("a mismatched standalone envelope carries no ownership or capability", () => {
    const env: NodeJS.ProcessEnv = {
      TRIBE_DAEMON_RELOAD_EXIT_CODE: "75",
      TRIBE_DAEMON_SUPERVISOR_PID: "123",
      TRIBE_OPERATOR_CAPABILITY_FD: "2147483647",
    }

    sanitizeDaemonProcessEnvironment(env, 456)

    expect(env).toEqual({})
  })

  test("the self-mailbox bearer is rereadable from inherited environment", () => {
    const env = { AG_SESSION_AUTH: "a".repeat(43) }
    expect(readSelfMailboxAuthorityFromEnvironment(env)).toBe("a".repeat(43))
    expect(readSelfMailboxAuthorityFromEnvironment(env)).toBe("a".repeat(43))
  })
})

describe("the scalar journal root survives standalone sanitizing (@i/4-supervision/24248)", () => {
  test("keeps HAB_SCALAR_JOURNAL_DIR while still stripping every lifecycle marker", () => {
    // The fix must not be stripped by the sanitizer it exists to work around.
    // This sanitizer is a DENY-LIST, so a new variable is retained by
    // construction — which means the risk is not today's code but tomorrow's
    // edit adding this name to the delete list, silently reintroducing the
    // exact blindness. That is what this pins.
    const kept = sanitizeStandaloneDaemonEnvironment({
      HAB_SCALAR_JOURNAL_DIR: "/hh/main.hab/run/sessions/habmod",
      HAB_SERVICE_KIND: "service",
      HAB_SERVICE_NAME: "tribe-daemon",
      HAB_SESSION_DIR: "/hh/main.hab/run/sessions/abc",
      PATH: "/usr/bin",
    })

    expect(kept.HAB_SCALAR_JOURNAL_DIR, "stripping this reintroduces the blindness").toBe(
      "/hh/main.hab/run/sessions/habmod",
    )
    // Asserted together on purpose: the whole point is that JOURNAL ACCESS
    // survives while LIFECYCLE does not. Losing either half is a defect.
    expect(kept.HAB_SESSION_DIR).toBeUndefined()
    expect(kept.HAB_SERVICE_KIND).toBeUndefined()
    expect(kept.HAB_SERVICE_NAME).toBeUndefined()
  })
})
