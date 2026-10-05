/**
 * @failure  an adapter derives its code root differently from the daemon it
 *           serves, so the (root, cert) identity gate can never agree and the
 *           adapter keeps executing a projection that moves under it
 *           (27531; /hh/hub/rulings/27531-adapter-root-design-note-ruling-2026-10-05.md).
 * @level    l0 - pure functions over a fixture landing, no process spawned
 * @consumer @i/4-supervision/27459-coordination-overhead-has-no-budget/27531-adapters-run-from-the-daemon-landing-root-learned-from-the-daemon-never-shared-main
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import {
  PLUGIN_ENTRY_SOURCE_ROOT_DEPTH,
  sourceRootFromPluginEntry,
  sourceRootFromWireModule,
  WIRE_MODULE_SOURCE_ROOT_DEPTH,
  DAEMON_LIB_SOURCE_ROOT_DEPTH,
} from "../src/lib/code-identity.ts"

const LANDING = "/hh/dev-landings/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

describe("tribe source root derivations", () => {
  it("the wire module resolves the landing its packages/wire/src sits in", () => {
    expect(sourceRootFromWireModule(`file://${LANDING}/packages/wire/src/stdio-adapter.ts`)).toBe(LANDING)
  })

  it("the plugin entry resolves the landing its plugins/claude sits in", () => {
    expect(sourceRootFromPluginEntry(`file://${LANDING}/plugins/claude/server.ts`)).toBe(LANDING)
  })

  it("every process kind agrees on the same fixture landing (no dual derivation drift)", () => {
    const wire = sourceRootFromWireModule(`file://${LANDING}/packages/wire/src/stdio-adapter.ts`)
    const plugin = sourceRootFromPluginEntry(`file://${LANDING}/plugins/claude/server.ts`)
    expect(wire).toBe(LANDING)
    expect(plugin).toBe(LANDING)
    expect(wire).toBe(plugin)
  })

  it("the depths are the shape, not a magic number at each call site", () => {
    expect(WIRE_MODULE_SOURCE_ROOT_DEPTH.split("/")).toHaveLength(3)
    expect(PLUGIN_ENTRY_SOURCE_ROOT_DEPTH.split("/")).toHaveLength(2)
    expect(DAEMON_LIB_SOURCE_ROOT_DEPTH.split("/")).toHaveLength(4)
  })
})
