/**
 * #30968 slice A — participant principals over a persistent transport (plan r2.1 rulings 3-5, F2-F4b, F6; @cto
 * 7e926481). A participant is a declared outside principal (the beorn-mac Mac reaching hab1 through the tribe stdio
 * adapter over SSH) whose Hab grant the injected verifier judges. These tests drive the real dispatcher with a
 * verifier stub that models Hab's grant state: active, revoked (generation bumped), expired, or unavailable.
 *
 * @failure A participant whose grant was revoked or expired keeps operating on its connected socket, a different
 *          principal takes its name, a stale generation displaces its successor, a CLI one-shot half-works, or a
 *          participant reaches fleet rights (incidents, fleet pending, rename, another inbox).
 * @level l2 — real dispatcher, real database, real handlers; only the verifier and the socket are stubs.
 * @consumer beorn-mac (and later the Grok bot) through tribe-identity-verifier.ts; @chief's tracked requests to them.
 * @testonly none
 * Existing registration tests cover agent and service tokens only; none exercises a participant kind, a per-call
 * re-verify on a connected socket, or a grant-state capability.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Server, Socket as NetSocket } from "node:net"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createScope } from "tribe-wire"
import { TRIBE_PROTOCOL_VERSION } from "tribe-wire/lib/socket"
import { deriveTribePersonaLaunchIdentity } from "tribe-wire/lib/persona-launch-identity"
import { createTribeContext } from "../context.ts"
import { openDatabase, createStatements } from "../database.ts"
import { withClientRegistry } from "./with-client-registry.ts"
import { createBaseTribe } from "./base.ts"
import { withDispatcher } from "./with-dispatcher.ts"
import { boundedIdentityVerifier, type LoadedIdentityVerifier } from "../identity-verifier.ts"

const PARTICIPANT = "@ext/beorn-mac"
const GRANT_ID = "4b1e7c52-0000-4000-8000-00000000beef"
const CHIEF = "@chief"

type Grant = { sid: string; generation: number; state: "active" | "revoked"; exp: number }

/** Hab's grant state, as the injected verifier sees it (ruling 1's liveness branch). */
function grantVerifier(): {
  verifier: LoadedIdentityVerifier
  grants: Map<string, Grant>
  setFault(fault: string | null): void
  now: { seconds: number }
  calls: () => number
} {
  const grants = new Map<string, Grant>()
  let fault: string | null = null
  let calls = 0
  const now = { seconds: Math.floor(Date.now() / 1000) }
  const verifier: LoadedIdentityVerifier = {
    path: "/test/participant-verifier",
    suppliesGen: true,
    verify: async (token) => {
      calls++
      if (fault !== null) throw new Error(fault)
      const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as {
        sid: string
        gen: number
        exp?: number
        act: { sub: string; kind?: string }
      }
      if (claims.act.kind !== "participant") {
        return { result: "verified", actor: claims.act.sub, sid: claims.sid, gen: claims.gen }
      }
      const grant = grants.get(claims.act.sub)
      if (grant === undefined) return { result: "contradicted", reason: `${claims.act.sub} is not declared` }
      if (grant.sid !== claims.sid) return { result: "contradicted", reason: "grant id does not match" }
      if (grant.state !== "active") return { result: "contradicted", reason: "grant is revoked" }
      if (grant.generation !== claims.gen) return { result: "contradicted", reason: "generation is not current" }
      if ((claims.exp ?? 0) <= now.seconds) return { result: "contradicted", reason: "token expired" }
      return {
        result: "verified",
        actor: claims.act.sub,
        kind: "participant",
        sid: claims.sid,
        gen: claims.gen,
        exp: claims.exp as number,
      }
    },
  }
  return {
    verifier,
    grants,
    setFault: (next) => {
      fault = next
    },
    now,
    calls: () => calls,
  }
}

const token = (claims: Record<string, unknown>) =>
  `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`
const participantToken = (gen: number, exp: number, sid = GRANT_ID, name = PARTICIPANT) =>
  token({ sid, gen, exp, act: { sub: name, kind: "participant" } })
const chiefToken = token({ sid: "chief-sid", gen: 1, act: { sub: CHIEF } })

let cleanup: (() => Promise<void>) | null = null
/**
 * Every refusal and verifier fault logs loudly (fail-loud); the host fails a test on console output, so each line is
 * captured here and must be one of those two kinds — any other output still fails the test.
 */
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
  const unexpected = logged.filter(
    (line) => / (WARN|ERROR) /.test(line) && !/ refused: |identity verifier \S+ failed on participant/.test(line),
  )
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
  const stub = grantVerifier()
  const tempDir = mkdtempSync(join(tmpdir(), "tribe-participant-"))
  const scope = createScope("dispatcher-participant-test")
  const db = openDatabase(join(tempDir, "tribe.sqlite"))
  const stmts = createStatements(db)
  scope.defer(() => rmSync(tempDir, { recursive: true, force: true }))
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
  const daemon = withDispatcher({ suppressWindowMs: Number.MAX_SAFE_INTEGER, identityVerifier: stub.verifier })(shape)
  cleanup = () => scope[Symbol.asyncDispose]()

  let seq = 0
  const call = async (connId: string, method: string, params: Record<string, unknown> = {}) =>
    JSON.parse(await daemon.dispatcher.handleRequest({ jsonrpc: "2.0", id: `r${++seq}`, method, params }, connId)) as {
      result?: unknown
      error?: RpcError
    }
  const tool = async (connId: string, method: string, params: Record<string, unknown> = {}) => {
    const response = await call(connId, method, params)
    if (response.error) return { error: response.error }
    const text = (response.result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}"
    return { body: JSON.parse(text) as Record<string, unknown> }
  }
  const connect = (): { connId: string; socket: NetSocket & { destroyed: boolean } } => {
    const socket = testSocket()
    daemon.dispatcher.handleConnection(socket)
    const connId = socketToClient.get(socket)
    if (!connId) throw new Error("dispatcher did not register the connected socket")
    return { connId, socket }
  }
  /** The beorn-mac stdio adapter's register: launch-named, its token, its own launch key and parent pid. */
  const registerParticipant = (connId: string, idToken: string, extra: Record<string, unknown> = {}) =>
    call(connId, "register", {
      name: PARTICIPANT,
      role: "member",
      pid: process.pid,
      project: "/Users/beorn",
      projectName: "beorn",
      projectId: "test-project",
      delivery: "pull",
      protocolVersion: TRIBE_PROTOCOL_VERSION,
      idToken,
      // Exactly what the adapter sends for a launch-named register (adapter-launch-identity.ts): its persona launch
      // key over the token's sid, and its OS parent (the SSH session's shell). The daemon keys neither.
      launchId: deriveTribePersonaLaunchIdentity(PARTICIPANT, GRANT_ID).providerLaunchKey,
      launchParentPid: process.pid,
      ...extra,
    })
  const registerChief = (connId: string) =>
    call(connId, "register", {
      name: CHIEF,
      role: "member",
      pid: process.pid,
      project: "/hh",
      projectName: "hh",
      projectId: "test-project",
      delivery: "pull",
      protocolVersion: TRIBE_PROTOCOL_VERSION,
      idToken: chiefToken,
      launchParentPid: process.pid,
    })
  const row = (name = PARTICIPANT) =>
    db
      .prepare(
        `SELECT id, name, pid, principal_class, launch_id, launch_parent_pid, identity_sid, identity_gen,
           verified_id_token, participant_grant FROM sessions WHERE name = ?`,
      )
      .get(name) as {
      id: string
      name: string
      pid: number
      principal_class: string
      launch_id: string | null
      launch_parent_pid: number | null
      identity_sid: string | null
      identity_gen: number | null
      verified_id_token: string | null
      participant_grant: string | null
    } | null
  const capability = async (connId: string, name = PARTICIPANT) => {
    const members = await tool(connId, "tribe.members")
    const sessions = (members.body?.sessions ?? []) as Array<{
      name: string
      transport_state: string
      mailbox_read_capability: { state: string; reason: string; grant_checked_at?: string }
    }>
    return sessions.find((session) => session.name === name)
  }
  const messagesTo = (name = PARTICIPANT) =>
    (db.prepare("SELECT COUNT(*) AS n FROM messages WHERE recipient = ?").get(name) as { n: number }).n
  const openBalls = (owner = PARTICIPANT) =>
    (db.prepare("SELECT COUNT(*) AS n FROM pending_request WHERE recipient = ?").get(owner) as { n: number }).n
  const sessionsNamed = (name = PARTICIPANT) =>
    (db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE name = ?").get(name) as { n: number }).n
  const grant = (gen: number, ttlSeconds = 3_600) => {
    const exp = stub.now.seconds + ttlSeconds
    stub.grants.set(PARTICIPANT, { sid: GRANT_ID, generation: gen, state: "active", exp })
    return participantToken(gen, exp)
  }
  return {
    db,
    stub,
    clients,
    call,
    tool,
    connect,
    registerParticipant,
    registerChief,
    row,
    capability,
    messagesTo,
    openBalls,
    sessionsNamed,
    grant,
    revoke() {
      const held = stub.grants.get(PARTICIPANT)
      if (!held) throw new Error("no grant to revoke")
      stub.grants.set(PARTICIPANT, { ...held, state: "revoked", generation: held.generation + 1 })
    },
  }
}

function testSocket(): NetSocket & { destroyed: boolean } {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>()
  const socket = {
    destroyed: false,
    writable: true,
    writes: [] as string[],
    write(payload: string | Uint8Array) {
      this.writes.push(String(payload))
      return true
    },
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
  return socket as unknown as NetSocket & { destroyed: boolean }
}

async function connectedPair(h: ReturnType<typeof harness>, gen = 1) {
  const chief = h.connect()
  expect((await h.registerChief(chief.connId)).error).toBeUndefined()
  const mac = h.connect()
  const registered = await h.registerParticipant(mac.connId, h.grant(gen))
  expect(registered.error).toBeUndefined()
  return { chief, mac, registered: registered.result as Record<string, unknown> }
}

describe("participant registration over a persistent transport (#30968 ruling 3, F3)", () => {
  it("keys the row <sid>@<gen> with no launch parent, records the class and the caller's pid", async () => {
    const h = harness()
    const { registered } = await connectedPair(h)
    expect(registered).toMatchObject({
      name: PARTICIPANT,
      principalClass: "participant",
      launchId: `${GRANT_ID}@1`,
      launchParentPid: null,
    })
    const stored = h.row()
    expect(stored).toMatchObject({
      principal_class: "participant",
      launch_id: `${GRANT_ID}@1`,
      launch_parent_pid: null,
      identity_sid: GRANT_ID,
      identity_gen: 1,
      pid: process.pid,
    })
    expect(JSON.parse(stored?.participant_grant ?? "null")).toMatchObject({ state: "active" })
  })

  it("re-registering the same (sid, gen, actor) is idempotent: the same row, one more transport", async () => {
    const h = harness()
    const { registered } = await connectedPair(h)
    const second = h.connect()
    const again = await h.registerParticipant(second.connId, participantToken(1, h.stub.grants.get(PARTICIPANT)!.exp))
    expect(again.error).toBeUndefined()
    expect((again.result as { sessionId: string }).sessionId).toBe(registered.sessionId)
    expect(h.sessionsNamed()).toBe(1)
  })

  it("refuses a declared class the token does not name, either way round", async () => {
    const h = harness()
    const mac = h.connect()
    const refused = await h.registerParticipant(mac.connId, h.grant(1), { principalClass: "agent" })
    expect(refused.error?.data).toMatchObject({ kind: "principal-class-mismatch" })
    const chief = h.connect()
    const chiefAsParticipant = await h.call(chief.connId, "register", {
      name: CHIEF,
      pid: process.pid,
      project: "/hh",
      idToken: chiefToken,
      launchParentPid: process.pid,
      principalClass: "participant",
      protocolVersion: TRIBE_PROTOCOL_VERSION,
    })
    expect(chiefAsParticipant.error?.data).toMatchObject({ kind: "principal-class-mismatch" })
    expect(h.sessionsNamed()).toBe(0)
  })
})

describe("the beorn-mac acceptance: @chief's tracked request round-trips through a connected participant", () => {
  it("queues the request, the participant fetches it, and its response+reply settles closed > 0", async () => {
    const h = harness()
    const { chief, mac } = await connectedPair(h)
    const asked = await h.tool(chief.connId, "tribe.send", {
      to: PARTICIPANT,
      type: "request",
      message: "beorn-mac: confirm the SSH command carries HAB_ID_TOKEN_FILE",
      summary: "confirm token file",
    })
    expect(asked.error).toBeUndefined()
    expect(asked.body).toMatchObject({ sent: true })
    const requestId = asked.body?.request_id as string
    expect(typeof requestId).toBe("string")
    expect(h.openBalls()).toBe(1)

    const fetched = await h.tool(mac.connId, "tribe.fetch", { limit: 10 })
    expect(fetched.error).toBeUndefined()
    expect(JSON.stringify(fetched.body)).toContain(requestId)

    const answered = await h.tool(mac.connId, "tribe.send", {
      to: CHIEF,
      type: "response",
      message: "confirmed",
      summary: "confirmed",
      reply: requestId,
    })
    expect(answered.error).toBeUndefined()
    expect((answered.body?.tracker as { closed: number }).closed).toBeGreaterThan(0)
    expect(h.openBalls()).toBe(0)
  })
})

describe("one-shot participants are refused by name until slice B (@cto 7e926481)", () => {
  it("a sessionless send, a token self-inbox read and a token pending read each name slice B", async () => {
    const h = harness()
    const token = h.grant(1)
    const oneShot = h.connect()
    const send = await h.call(oneShot.connId, "tribe.send", {
      to: CHIEF,
      type: "notify",
      message: "hello",
      idToken: token,
    })
    expect(send.error?.message).toContain("one-shot participants arrive in #30968 slice B")
    expect(send.error?.data).toMatchObject({ reason: "participant-one-shot-unsupported" })
    const inbox = await h.call(oneShot.connId, "cli_self_inbox_v1", { idToken: token, limit: 5, peek: true })
    expect(inbox.error?.message).toContain("one-shot participants arrive in #30968 slice B")
    const pending = await h.call(oneShot.connId, "cli_session_pending_read_v1", { idToken: token })
    expect(pending.error?.message).toContain("one-shot participants arrive in #30968 slice B")
    // Nothing half-ran: no row, no message.
    expect(h.sessionsNamed()).toBe(0)
    expect(h.messagesTo(CHIEF)).toBe(0)
  })

  it("the same token on its registered persistent transport operates (the path beside the refusal)", async () => {
    const h = harness()
    const { mac } = await connectedPair(h)
    const sent = await h.tool(mac.connId, "tribe.send", { to: CHIEF, type: "notify", message: "hello" })
    expect(sent.error).toBeUndefined()
    expect(sent.body).toMatchObject({ sent: true })
  })
})

describe("ruling 4: every protected call re-verifies the participant's token", () => {
  it("revoke between calls: the next fetch is refused participant-grant-revoked; the journal keeps its rows", async () => {
    const h = harness()
    const { chief, mac } = await connectedPair(h)
    await h.tool(chief.connId, "tribe.send", { to: PARTICIPANT, type: "request", message: "q", summary: "q" })
    expect((await h.tool(mac.connId, "tribe.fetch", { limit: 5 })).error).toBeUndefined()
    const before = { messages: h.messagesTo(), balls: h.openBalls() }
    h.revoke()
    const refused = await h.tool(mac.connId, "tribe.fetch", { limit: 5 })
    expect(refused.error?.data).toMatchObject({ reason: "participant-grant-revoked" })
    expect({ messages: h.messagesTo(), balls: h.openBalls() }).toEqual(before)
  })

  it("expiry between calls: the next call is refused participant-grant-expired", async () => {
    const h = harness()
    const { mac } = await connectedPair(h)
    expect((await h.tool(mac.connId, "tribe.pending")).error).toBeUndefined()
    const later = Date.now() + 2 * 3_600_000
    h.stub.now.seconds = Math.floor(later / 1000)
    vi.spyOn(Date, "now").mockReturnValue(later)
    const refused = await h.tool(mac.connId, "tribe.pending")
    expect(refused.error?.data).toMatchObject({ reason: "participant-grant-expired" })
    expect(JSON.parse(h.row()?.participant_grant ?? "null")).toMatchObject({ state: "expired" })
  })

  it("an expired token that still verifies is refused on its own expiry", async () => {
    const h = harness()
    const { mac } = await connectedPair(h)
    // A verifier that judged everything but the clock: tribe re-checks exp itself.
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2 * 3_600_000)
    const refused = await h.tool(mac.connId, "tribe.send", { to: CHIEF, type: "notify", message: "late" })
    expect(refused.error?.data).toMatchObject({ reason: "participant-grant-expired" })
  })

  it("revoke while connected: the next send is refused and the row reads unavailable while still connected", async () => {
    const h = harness()
    const { chief, mac } = await connectedPair(h)
    expect((await h.capability(chief.connId))?.mailbox_read_capability).toMatchObject({
      state: "available",
      reason: "self-mailbox-authority-token",
    })
    h.revoke()
    const refused = await h.tool(mac.connId, "tribe.send", { to: CHIEF, type: "notify", message: "after revoke" })
    expect(refused.error?.data).toMatchObject({ reason: "participant-grant-revoked" })
    expect(h.messagesTo(CHIEF)).toBe(0)
    const seen = await h.capability(chief.connId)
    expect(seen?.transport_state).toBe("connected")
    expect(seen?.mailbox_read_capability).toMatchObject({ state: "unavailable", reason: "participant-grant-revoked" })
    expect(typeof seen?.mailbox_read_capability.grant_checked_at).toBe("string")
  })

  it("revoke during a waiting read: the wait returns no content and is refused", async () => {
    const h = harness()
    const { chief, mac } = await connectedPair(h)
    const waiting = h.call(mac.connId, "tribe.inbox.wait", { timeoutMs: 200 })
    h.revoke()
    await h.tool(chief.connId, "tribe.send", { to: PARTICIPANT, type: "request", message: "wake", summary: "wake" })
    const answered = await waiting
    expect(answered.result).toBeUndefined()
    expect(answered.error?.data).toMatchObject({ reason: "participant-grant-revoked" })
    expect(h.messagesTo()).toBe(1)
  })

  it("verifier unavailable: refused as unavailable authority, the grant not marked revoked, no row deleted", async () => {
    const h = harness()
    const { chief, mac } = await connectedPair(h)
    await h.tool(chief.connId, "tribe.send", { to: PARTICIPANT, type: "request", message: "q", summary: "q" })
    const before = { messages: h.messagesTo(), balls: h.openBalls(), rows: h.sessionsNamed() }
    h.stub.setFault("hab identity state unreadable: participants.json missing")
    const refused = await h.tool(mac.connId, "tribe.fetch", { limit: 5 })
    expect(refused.error?.data).toMatchObject({ reason: "identity-verifier-fault" })
    expect(refused.error?.message).toContain("not marked revoked")
    expect(JSON.parse(h.row()?.participant_grant ?? "null")).toMatchObject({ state: "unavailable" })
    expect({ messages: h.messagesTo(), balls: h.openBalls(), rows: h.sessionsNamed() }).toEqual(before)
    h.stub.setFault(null)
    expect((await h.tool(mac.connId, "tribe.fetch", { limit: 5 })).error).toBeUndefined()
    expect(JSON.parse(h.row()?.participant_grant ?? "null")).toMatchObject({ state: "active" })
  })

  it("re-verifies fresh through the bounded verifier: a revoke inside the cache TTL lands on the next call", async () => {
    const stub = grantVerifier()
    const bounded = boundedIdentityVerifier(stub.verifier, { ttlMs: 60_000 })
    const exp = stub.now.seconds + 3_600
    stub.grants.set(PARTICIPANT, { sid: GRANT_ID, generation: 1, state: "active", exp })
    const tok = participantToken(1, exp)
    expect((await bounded.verify(tok)).result).toBe("verified")
    stub.grants.set(PARTICIPANT, { sid: GRANT_ID, generation: 2, state: "revoked", exp })
    expect((await bounded.verify(tok)).result).toBe("verified") // cached: the ordinary path
    expect((await bounded.verify(tok, { fresh: true })).result).toBe("contradicted")
  })
})

describe("generation rollover, siblings and conflicts (ruling 3, F6)", () => {
  it("gen-2 supersedes gen-1 on the same mailbox; gen-1 is refused", async () => {
    const h = harness()
    const { chief, mac } = await connectedPair(h, 1)
    const firstSession = h.row()?.id
    await h.tool(chief.connId, "tribe.send", { to: PARTICIPANT, type: "request", message: "kept", summary: "kept" })
    const gen1 = participantToken(1, h.stub.grants.get(PARTICIPANT)!.exp)
    const gen2 = h.grant(2) // a second mint: generation bumped, same grant id
    const mac2 = h.connect()
    expect((await h.registerParticipant(mac2.connId, gen2)).error).toBeUndefined()
    expect(h.row()).toMatchObject({ id: firstSession, identity_gen: 2, launch_id: `${GRANT_ID}@2` })
    expect(mac.socket.destroyed).toBe(true)
    const stale = h.connect()
    // The verifier already contradicts a replaced generation's token, so it never reaches the row.
    const refused = await h.registerParticipant(stale.connId, gen1)
    expect(refused.error?.data).toMatchObject({ kind: "identity-contradicted" })
    expect(h.row()).toMatchObject({ id: firstSession, identity_gen: 2 })
    const fetched = await h.tool(mac2.connId, "tribe.fetch", { limit: 10 })
    expect(fetched.error).toBeUndefined()
    expect(JSON.stringify(fetched.body)).toContain("kept")
  })

  it("a tokenless sibling of the name is refused and the participant stays answerable", async () => {
    const h = harness()
    const { chief } = await connectedPair(h)
    const sibling = h.connect()
    const refused = await h.call(sibling.connId, "register", {
      name: PARTICIPANT,
      pid: process.pid,
      project: "/tmp",
      protocolVersion: TRIBE_PROTOCOL_VERSION,
    })
    expect(refused.error?.data).toMatchObject({ kind: "identity-token-missing" })
    expect(h.sessionsNamed()).toBe(1)
    expect((await h.capability(chief.connId))?.mailbox_read_capability.state).toBe("available")
    const asked = await h.tool(chief.connId, "tribe.send", {
      to: PARTICIPANT,
      type: "request",
      message: "still there?",
      summary: "still there",
    })
    expect(asked.body).toMatchObject({ sent: true })
  })

  it("a different principal claiming the name is refused as a conflict and the row is untouched", async () => {
    const h = harness()
    await connectedPair(h)
    const before = h.row()
    const otherSid = "9f0d4c11-0000-4000-8000-0000000000aa"
    h.stub.grants.set(PARTICIPANT, { sid: otherSid, generation: 1, state: "active", exp: h.stub.now.seconds + 60 })
    const intruder = h.connect()
    const refused = await h.registerParticipant(
      intruder.connId,
      participantToken(1, h.stub.now.seconds + 60, otherSid),
      {
        launchId: deriveTribePersonaLaunchIdentity(PARTICIPANT, otherSid).providerLaunchKey,
      },
    )
    expect(refused.error?.data).toMatchObject({ kind: "participant-principal-conflict" })
    expect(h.row()).toEqual(before)
  })

  it("a tracked request to a revoked participant bounces participant-grant-revoked, opens no ball, keeps the journal", async () => {
    const h = harness()
    const { chief, mac } = await connectedPair(h)
    await h.tool(chief.connId, "tribe.send", { to: PARTICIPANT, type: "notify", message: "earlier", summary: "e" })
    h.revoke()
    // The revoke reaches the row at the participant's next protected call.
    await h.tool(mac.connId, "tribe.fetch", { limit: 1 })
    const before = h.messagesTo()
    const bounced = await h.tool(chief.connId, "tribe.send", {
      to: PARTICIPANT,
      type: "request",
      message: "answer me",
      summary: "answer me",
    })
    expect(JSON.stringify(bounced)).toContain("participant-grant-revoked")
    expect(bounced.body?.sent).not.toBe(true)
    expect(h.openBalls()).toBe(0)
    expect(h.messagesTo()).toBe(before)
    // Untracked notify still delivers, as for any deaf mailbox (24581).
    const notified = await h.tool(chief.connId, "tribe.send", { to: PARTICIPANT, type: "notify", message: "fyi" })
    expect(notified.body).toMatchObject({ sent: true })
  })
})

describe("ruling 5: ordinary own-mailbox rights only", () => {
  it.each([
    [
      "incident raise",
      "tribe.send",
      { to: CHIEF, message: "x", incident: { emitter: "workmon", subject: "s", condition: "c" } },
    ],
    ["fleet pending", "tribe.pending", { all: true }],
    ["closing another's balls", "tribe.pending", { owner: CHIEF, close: "abc" }],
    ["claiming a solicitation", "tribe.pending", { claim: "abc" }],
    ["rename", "tribe.rename", { new_name: "@ext/other" }],
    ["lifecycle publish", "tribe.lifecycle.publish", { snapshot: {} }],
    ["another identity's inbox", "tribe.inbox.wait", { session: CHIEF, timeoutMs: 1 }],
    ["join as another name", "tribe.join", { name: "@dev/1" }],
    ["fleet restart", "tribe.restart", {}],
  ] as const)("refuses %s by name", async (_what, method, params) => {
    const h = harness()
    const { mac } = await connectedPair(h)
    const verifiesBefore = h.stub.calls()
    const refused = await h.call(mac.connId, method, params as Record<string, unknown>)
    expect(refused.error?.data).toMatchObject({ reason: "participant-right-refused" })
    expect(refused.error?.message).toContain("#30968 ruling 5")
    // A right the participant does not hold is refused before any verifier spawn.
    expect(h.stub.calls()).toBe(verifiesBefore)
  })

  it("permits its own pending and a join under its own name", async () => {
    const h = harness()
    const { mac } = await connectedPair(h)
    expect((await h.call(mac.connId, "tribe.pending", {})).error).toBeUndefined()
    expect((await h.call(mac.connId, "tribe.join", { name: PARTICIPANT })).error).toBeUndefined()
  })
})
