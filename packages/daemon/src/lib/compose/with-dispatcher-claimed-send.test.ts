/**
 * #37676 (@cto 9581cc76): an unverified (claimed) session could broadcast and assign as itself or as `unknown-<rand>`,
 * because the participant gate fires only for `principalClass === "participant"` and no gate applied to claimed
 * authority. A claimed session may neither broadcast nor open a ball; its one send right is a response settling an
 * open ball it already owns. Verified and participant paths must stay unchanged.
 *
 * @failure A tokenless local process reaches the daemon socket and addresses a message as a seat, or opens a ball on
 *          a seat, so coordination state is attributed to an identity nothing verified.
 * @level l2 — real dispatcher, real database, real handlers; only the socket is a stub.
 * @consumer hab1's socket for every seat; @cto ruling 9581cc76 and the #30968 audit it extends.
 * @testonly none
 * Existing tests cover the participant gate (#30968) and registration authority; none sends from a claimed session.
 */
import { mkdtempSync, realpathSync } from "node:fs"
import { safeRemoveSync } from "removely"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Server, Socket as NetSocket } from "node:net"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createScope } from "tribe-wire"
import { TRIBE_PROTOCOL_VERSION } from "tribe-wire/lib/socket"
import { createTribeContext } from "../context.ts"
import { openDatabase, createStatements } from "../database.ts"
import { withClientRegistry } from "./with-client-registry.ts"
import { createBaseTribe } from "./base.ts"
import { withDispatcher } from "./with-dispatcher.ts"
import type { LoadedIdentityVerifier } from "../identity-verifier.ts"

// A plain name registers as claimed without a token; an explicit `@persona` name is refused without one.
const CLAIMED = "hand-shell"
const VERIFIED = "@dev/claimed-test"

const token = (claims: Record<string, unknown>) =>
  `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`
const verifiedToken = token({ sid: "claimed-test-sid", gen: 1, act: { sub: VERIFIED } })

/** The verifier a host with a token file supplies: this stub verifies the token's own claims. */
const verifier: LoadedIdentityVerifier = {
  path: "/test/claimed-send-verifier",
  suppliesGen: true,
  verify: async (value) => {
    const claims = JSON.parse(Buffer.from(value.split(".")[1] ?? "", "base64url").toString("utf8")) as {
      sid: string
      gen: number
      act: { sub: string }
    }
    return { result: "verified", actor: claims.act.sub, sid: claims.sid, gen: claims.gen }
  },
}

let cleanup: (() => Promise<void>) | null = null
let logged: string[] = []
beforeEach(() => {
  logged = []
  const capture = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "))
  }
  vi.spyOn(console, "warn").mockImplementation(capture)
  vi.spyOn(console, "error").mockImplementation(capture)
})
afterEach(async () => {
  const unexpected = logged.filter((line) => / (WARN|ERROR) /.test(line) && !/ refused: /.test(line))
  vi.restoreAllMocks()
  if (cleanup) {
    const dispose = cleanup
    cleanup = null
    await dispose()
  }
  expect(unexpected).toEqual([])
})

type RpcError = { code: number; message: string; data?: Record<string, unknown> }

function harness() {
  const tempDir = mkdtempSync(join(realpathSync(tmpdir()), "tribe-claimed-send-"))
  const scope = createScope("dispatcher-claimed-send-test")
  const db = openDatabase(join(tempDir, "tribe.sqlite"))
  const stmts = createStatements(db)
  scope.defer(() => safeRemoveSync(tempDir, { within: realpathSync(tmpdir()) }))
  scope.defer(() => db.close())
  const daemonCtx = createTribeContext({
    db,
    stmts,
    sessionId: "daemon-test",
    sessionRole: "daemon",
    initialName: "daemon",
    domains: [],
    claudeSessionId: null,
    claudeSessionName: null,
    onMessageInserted: undefined,
  })
  const { registry } = withClientRegistry()(createBaseTribe({ scope }))
  const { clients, socketToClient } = registry
  const fakeServer = { on: () => fakeServer, removeListener: () => fakeServer } as unknown as Server
  const shape = {
    scope,
    daemonSessionId: "daemon-test",
    startedAt: Date.now(),
    daemonVersion: "test",
    daemonPid: process.pid,
    config: {
      socketPath: join(tempDir, "tribe.sock"),
      dbPath: join(tempDir, "tribe.sqlite"),
      recallDbPath: join(tempDir, "recall.sqlite"),
      vaultDbPath: null,
      idleQuitAfterSec: -1,
      idleQuitSource: "flag" as const,
      inheritFd: null,
      focusPollMs: 60_000,
      summaryPollMs: 120_000,
      summarizerMode: "off" as const,
      recallEnabled: false,
      operatorCapability: null,
    },
    db,
    stmts,
    daemonCtx,
    recall: null,
    registry,
    broadcast: {
      notify() {},
      pushToClient() {},
      persistDeliveredCursor() {},
      async toConnected() {},
      log() {},
      flushConnection() {},
      discardConnection() {},
      messageTap() {},
    },
    socket: {
      server: fakeServer,
      socketPath: join(tempDir, "tribe.sock"),
      binding: Promise.resolve("listening" as const),
      inheritedFd: false,
      startedAt: Date.now(),
      handedOff: false,
    },
  }
  const daemon = withDispatcher({ suppressWindowMs: Number.MAX_SAFE_INTEGER, identityVerifier: verifier })(shape)
  cleanup = () => scope[Symbol.asyncDispose]()

  let seq = 0
  const call = async (connId: string, method: string, params: Record<string, unknown> = {}) =>
    JSON.parse(await daemon.dispatcher.handleRequest({ jsonrpc: "2.0", id: `r${++seq}`, method, params }, connId)) as {
      result?: unknown
      error?: RpcError
    }
  const tool = async (connId: string, name: string, args: Record<string, unknown> = {}) => {
    const response = await call(connId, name, args)
    if (response.error) return { error: response.error }
    const result = response.result as { content?: Array<{ text: string }> } & Record<string, unknown>
    if (Array.isArray(result?.content)) {
      return { body: JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown> }
    }
    return { body: (response.result ?? {}) as Record<string, unknown> }
  }
  const connect = (): string => {
    const handlers = new Map<string, Array<(...args: unknown[]) => void>>()
    const socket = {
      destroyed: false,
      writable: true,
      write: () => true,
      destroy() {
        this.destroyed = true
        this.writable = false
        return this
      },
      end() {
        return this
      },
      on(event: string, handler: (...args: unknown[]) => void) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler])
        return this
      },
      once(event: string, handler: (...args: unknown[]) => void) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler])
        return this
      },
    }
    const netSocket = socket as unknown as NetSocket
    daemon.dispatcher.handleConnection(netSocket)
    const connId = socketToClient.get(netSocket)
    if (!connId) throw new Error("dispatcher did not register the connected socket")
    return connId
  }
  const register = (connId: string, name: string, idToken?: string) =>
    call(connId, "register", {
      ...(name === "" ? {} : { name }),
      pid: process.pid,
      project: "/hh",
      projectName: "hh",
      projectId: "test-project",
      delivery: "pull",
      protocolVersion: TRIBE_PROTOCOL_VERSION,
      ...(idToken === undefined ? {} : { idToken, launchParentPid: process.pid }),
    })
  const messages = (recipient?: string) =>
    (recipient === undefined
      ? db.prepare("SELECT COUNT(*) AS n FROM messages").get()
      : db.prepare("SELECT COUNT(*) AS n FROM messages WHERE recipient = ?").get(recipient)) as { n: number }
  /** An open ball the claimed seat owns, as @chief's request would leave it. */
  const openBall = (requestId: string, recipient: string, sender = "@chief") => {
    db.prepare(
      "INSERT INTO pending_request (request_id, recipient, sender, message_id, opened_at, fanout, request_kind) VALUES (?, ?, ?, ?, ?, 'first', 'request')",
    ).run(requestId, recipient, sender, requestId, Date.now())
  }
  const ballsOn = (recipient: string) =>
    (db.prepare("SELECT COUNT(*) AS n FROM pending_request WHERE recipient = ?").get(recipient) as { n: number }).n
  const ballOpen = (requestId: string) =>
    db.prepare("SELECT 1 AS hit FROM pending_request WHERE request_id = ?").get(requestId) !== null
  return { connect, call, tool, register, messages, openBall, ballsOn, ballOpen, clients }
}

describe("a claimed session's send rights (#37676)", () => {
  it("refuses a broadcast by name and writes nothing", async () => {
    const h = harness()
    const connId = h.connect()
    expect((await h.register(connId, CLAIMED)).error).toBeUndefined()
    const baseline = h.messages().n
    const sent = await h.tool(connId, "tribe.send", { to: "*", type: "notify", message: "hello fleet" })
    expect(sent.error?.data).toMatchObject({ kind: "unauthenticated", reason: "unverified-session-send-refused" })
    expect(sent.error?.message).toContain("broadcast")
    expect(h.messages().n).toBe(baseline)
  })

  it("refuses request and assign to a seat, so no ball opens", async () => {
    const h = harness()
    const connId = h.connect()
    expect((await h.register(connId, CLAIMED)).error).toBeUndefined()
    const baseline = h.messages().n
    const asked = await h.tool(connId, "tribe.send", { to: "@chief", type: "request", message: "do a thing" })
    expect(asked.error?.data).toMatchObject({ reason: "unverified-session-send-refused" })
    const assigned = await h.tool(connId, "tribe.send", { to: "@chief", type: "assign", message: "take this" })
    expect(assigned.error?.data).toMatchObject({ reason: "unverified-session-send-refused" })
    expect(h.messages().n).toBe(baseline)
  })

  it("refuses a notify as well: the ruling keeps only the own-ball response", async () => {
    const h = harness()
    const connId = h.connect()
    expect((await h.register(connId, CLAIMED)).error).toBeUndefined()
    const baseline = h.messages().n
    const sent = await h.tool(connId, "tribe.send", { to: "@chief", type: "notify", message: "status" })
    expect(sent.error?.data).toMatchObject({ reason: "unverified-session-send-refused" })
    expect(h.messages().n).toBe(baseline)
  })

  it("accepts the one right it keeps: a response settling an open ball it owns", async () => {
    const h = harness()
    const connId = h.connect()
    expect((await h.register(connId, CLAIMED)).error).toBeUndefined()
    h.openBall("ball-37676-own", CLAIMED)
    const settled = await h.tool(connId, "tribe.send", {
      to: "@chief",
      type: "response",
      reply: "ball-37676-own",
      message: "done",
    })
    expect(settled.error).toBeUndefined()
    expect(settled.body).toMatchObject({ sent: true })
    expect(h.messages("@chief").n).toBeGreaterThan(0)
  })

  it("refuses a response whose reply names no ball it owns", async () => {
    const h = harness()
    const connId = h.connect()
    expect((await h.register(connId, CLAIMED)).error).toBeUndefined()
    // A ball on another seat: the claimed session answers nothing of its own here.
    h.openBall("ball-37676-other", "@chief", "@dev/other")
    const settled = await h.tool(connId, "tribe.send", {
      to: "@chief",
      type: "response",
      reply: "ball-37676-other",
      message: "done",
    })
    expect(settled.error?.data).toMatchObject({ reason: "unverified-session-send-refused" })
    expect(settled.error?.message).toContain("settles no open ball")
  })

  it("refuses an unnamed session (unknown-<rand>) the same way", async () => {
    const h = harness()
    const connId = h.connect()
    const registered = await h.register(connId, "")
    expect(registered.error).toBeUndefined()
    expect((registered.result as { name: string }).name).toMatch(/^unknown-/u)
    const baseline = h.messages().n
    const sent = await h.tool(connId, "tribe.send", { to: "*", type: "notify", message: "hello" })
    expect(sent.error?.data).toMatchObject({ reason: "unverified-session-send-refused" })
    expect(h.messages().n).toBe(baseline)
  })

  it("leaves a verified session's broadcast and request unchanged", async () => {
    const h = harness()
    const connId = h.connect()
    expect((await h.register(connId, VERIFIED, verifiedToken)).error).toBeUndefined()
    const baseline = h.messages().n
    const sent = await h.tool(connId, "tribe.send", { to: "*", type: "notify", message: "hello fleet" })
    expect(sent.error).toBeUndefined()
    expect(sent.body?.sent).toBeTruthy()
    const asked = await h.tool(connId, "tribe.send", { to: "@chief", type: "request", message: "do a thing" })
    expect(asked.error).toBeUndefined()
    expect(h.messages().n).toBeGreaterThan(baseline)
  })
})
