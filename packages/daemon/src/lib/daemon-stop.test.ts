/**
 * @failure A casual RPC caller stops the shared coordination daemon, or the stop
 *          path silently no-ops when the shutdown hook is missing.
 * @level   unit
 * @consumer tribe.stop — the sanctioned end of the socket-squatter kill era
 *
 * `tribe.stop` shuts the daemon down cleanly (drain, close socket, exit 0)
 * WITHOUT the SIGHUP/lifecycle-owner restart path. It must refuse without an
 * explicit `force: true` — every registered session coordinates through this
 * process — and must say so loudly when the handler surface has no shutdown
 * hook instead of pretending to stop anything. It deliberately has no MCP
 * command descriptor, so bridge sessions cannot reach it at all.
 */

import type { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createTribeContext, type TribeContext } from "./context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { handleToolCall, TRIBE_COORD_METHODS, type HandlerOpts } from "./handlers.ts"
import { TRIBE_COMMAND_DESCRIPTORS } from "../../../wire/src/command-descriptors.ts"

function makeOpts(overrides: Partial<HandlerOpts> = {}): HandlerOpts {
  return {
    cleanup: () => undefined,
    userRenamed: false,
    setUserRenamed: () => undefined,
    getActiveSessionIds: () => new Set(),
    hasActiveTransport: () => false,
    getActiveSessionInfo: () => [],
    ...overrides,
  }
}

function parseToolJson(result: Awaited<ReturnType<typeof handleToolCall>>): Record<string, unknown> {
  const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}"
  return JSON.parse(text) as Record<string, unknown>
}

describe("tribe.stop", () => {
  let tmpDir: string
  let db: Database
  let stmts: TribeStatements
  let ctx: TribeContext

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tribe-stop-"))
    db = openDatabase(join(tmpDir, "tribe.db"))
    stmts = createStatements(db)
    ctx = createTribeContext({
      db,
      stmts,
      sessionId: "stop-caller",
      sessionRole: "member",
      initialName: "@stop-caller",
      domains: [],
      claudeSessionId: null,
      claudeSessionName: null,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("refuses without force — and does not touch the shutdown hook", async () => {
    const triggerStop = vi.fn()
    const result = parseToolJson(await handleToolCall(ctx, TRIBE_COORD_METHODS.stop, {}, makeOpts({ triggerStop })))
    expect(result.error).toMatch(/tribe\.stop refused/)
    expect(result.error).toMatch(/--force/)
    expect(result.stopping).toBeUndefined()
    expect(triggerStop).not.toHaveBeenCalled()
  })

  it('refuses force values that are not boolean true (no "truthy" acceptance)', async () => {
    for (const force of ["true", 1, {}]) {
      const triggerStop = vi.fn()
      const result = parseToolJson(
        await handleToolCall(ctx, TRIBE_COORD_METHODS.stop, { force }, makeOpts({ triggerStop })),
      )
      expect(result.error).toMatch(/tribe\.stop refused/)
      expect(triggerStop).not.toHaveBeenCalled()
    }
  })

  it("with force: acknowledges first, then triggers the clean shutdown after the flush delay", async () => {
    vi.useFakeTimers()
    const triggerStop = vi.fn()
    const result = parseToolJson(
      await handleToolCall(
        ctx,
        TRIBE_COORD_METHODS.stop,
        { force: true, reason: "test stop" },
        makeOpts({ triggerStop }),
      ),
    )
    expect(result).toMatchObject({ stopping: true, reason: "test stop", pid: process.pid })
    // The response must flush before the daemon dies — nothing fires synchronously.
    expect(triggerStop).not.toHaveBeenCalled()
    vi.advanceTimersByTime(150)
    expect(triggerStop).toHaveBeenCalledTimes(1)
  })

  it("journals the stop decision before acting", async () => {
    vi.useFakeTimers()
    await handleToolCall(
      ctx,
      TRIBE_COORD_METHODS.stop,
      { force: true, reason: "audit me" },
      makeOpts({ triggerStop: vi.fn() }),
    )
    const row = db
      .query("SELECT content FROM messages WHERE type = 'event.daemon.stop' ORDER BY ts DESC LIMIT 1")
      .get() as { content: string } | null
    expect(row).not.toBeNull()
    expect(row?.content).toContain("audit me")
  })

  it("reports itself unavailable — loudly — when the surface has no shutdown hook", async () => {
    const result = parseToolJson(await handleToolCall(ctx, TRIBE_COORD_METHODS.stop, { force: true }, makeOpts()))
    expect(result.error).toMatch(/tribe\.stop unavailable/)
  })

  it("has no MCP command descriptor: bridge sessions cannot see or call it", () => {
    // The MCP tool surface is projected 1:1 from the descriptor list
    // (tools-list.ts). Absence here IS absence from every bridge.
    expect(TRIBE_COMMAND_DESCRIPTORS.some((descriptor) => descriptor.id === "tribe.stop")).toBe(false)
    expect(TRIBE_COMMAND_DESCRIPTORS.some((descriptor) => descriptor.mcp.name === "stop")).toBe(false)
  })
})
