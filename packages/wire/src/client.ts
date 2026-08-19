/**
 * Daemon client — connect to a Unix-socket JSON-RPC daemon, send requests
 * and notifications, receive responses and pushed notifications.
 *
 * Three layers, lowest to highest:
 *
 *  1. `connectToDaemon(socketPath, opts?)` — plain connect; rejects on
 *     ECONNREFUSED / ENOENT. Per-call timeout configurable.
 *  2. `connectOrStart(socketPath, opts)` — connect; if no daemon, start one
 *     through a stable standalone lifecycle owner and retry with exponential
 *     backoff.
 *  3. `createReconnectingClient(opts)` — proxy that wraps a current client
 *     and transparently reconnects (via connectOrStart) on socket close,
 *     replaying registered notification handlers.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync } from "node:fs"
import { createConnection, type Socket } from "node:net"
import { spawn } from "node:child_process"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createLogger } from "loggily"
import { createLineParser } from "./parser.ts"
import { evaluateSpawnSourceForScript } from "./lib/spawn-pin-gate.ts"
import { isNotification, isResponse, makeNotification, makeRequest } from "./rpc.ts"
import { sanitizeStandaloneDaemonEnvironment } from "./daemon-environment.ts"
import { createTimers } from "./timers.ts"

const log = createLogger("tribe-client:client")

// ---------------------------------------------------------------------------
// Daemon client
// ---------------------------------------------------------------------------

export type DaemonClient = {
  /** Send a JSON-RPC request and wait for response */
  call(method: string, params?: Record<string, unknown>, opts?: DaemonCallOpts): Promise<unknown>
  /** Send a notification (no response expected) */
  notify(method: string, params?: Record<string, unknown>): void
  /** Register a handler for server-pushed notifications */
  onNotification(handler: (method: string, params?: Record<string, unknown>) => void): void
  /** Close the connection */
  close(): void
  /** The raw socket */
  socket: Socket
}

export type DaemonCallOpts = {
  /** Override the generic request deadline for this call. */
  timeoutMs?: number
}

class DaemonCallTimeoutError extends Error {
  readonly code = "TRIBE_DAEMON_CALL_TIMEOUT" as const

  constructor(
    readonly method: string,
    readonly timeoutMs: number,
  ) {
    super(`Request ${method} timed out after ${timeoutMs}ms; check Tribe daemon health before retrying`)
    this.name = "DaemonCallTimeoutError"
  }
}

export type ConnectToDaemonOpts = {
  /** Per-call request timeout. Default: 10000 ms. */
  callTimeoutMs?: number
}

export function connectToDaemon(socketPath: string, opts?: ConnectToDaemonOpts): Promise<DaemonClient> {
  const callTimeoutMs = opts?.callTimeoutMs ?? 10_000
  return new Promise((resolvePromise, reject) => {
    const socket = createConnection(socketPath)
    type PendingCall = {
      resolve: (value: unknown) => void
      reject: (error: Error) => void
      timer?: ReturnType<typeof globalThis.setTimeout>
    }
    const pending = new Map<number | string, PendingCall>()
    const notificationHandlers: Array<(method: string, params?: Record<string, unknown>) => void> = []
    let nextId = 1

    const ac = new AbortController()
    const timers = createTimers(ac.signal)

    function rejectPending(err: Error): void {
      for (const [, p] of pending) {
        if (p.timer !== undefined) timers.clearTimeout(p.timer)
        p.reject(err)
      }
      pending.clear()
      ac.abort()
    }

    const parse = createLineParser((msg) => {
      if (isResponse(msg)) {
        const p = pending.get(msg.id)
        if (p) {
          pending.delete(msg.id)
          if (p.timer !== undefined) timers.clearTimeout(p.timer)
          if (msg.error)
            p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code, data: msg.error.data }))
          else p.resolve(msg.result)
        }
      } else if (isNotification(msg)) {
        for (const h of notificationHandlers) h(msg.method, msg.params)
      }
    })

    socket.on("data", parse)
    socket.on("error", reject)
    socket.once("connect", () => {
      socket.removeListener("error", reject)
      socket.on("error", (err) => {
        log.error?.(`Connection error: ${err.message}`)
        rejectPending(err)
      })
      socket.on("close", () => {
        rejectPending(new Error("Connection closed"))
      })
      // task/wire-postreg-close-cto — a server-side socket.destroy() reliably delivers 'end' to
      // this client (peer EOF), but under contention 'close' can simply
      // never follow: reproduced directly on task/wire-postreg-close-cto —
      // an instrumented run showed the accepted socket close on the
      // daemon's side in under 10ms every time, while the client's raw
      // socket fired 'connect' then 'end' and NOTHING else for the rest of
      // a 40s window. Node's documented allowHalfOpen:false behavior is to
      // auto-finish the writable side on EOF and tear the handle down,
      // which should end in 'close' — Bun does not reliably complete that
      // sequence under load. 'close' is the ONLY event this module (and
      // createReconnectingClient's reconnect trigger, see setupReconnect
      // below) reacts to, so a socket stuck half-open here is a socket
      // that never gets noticed as dead. Forcing our own destroy() on
      // 'end' makes closure unconditional on Bun's internal bookkeeping:
      // once the peer says "no more data," the link is over.
      socket.on("end", () => {
        if (!socket.destroyed) socket.destroy()
      })

      let timeouts = 0
      const client: DaemonClient = {
        call(method, params, callOpts) {
          return new Promise((res, rej) => {
            const id = nextId++
            const explicitTimeoutMs = callOpts?.timeoutMs
            const requestTimeoutMs =
              explicitTimeoutMs !== undefined && Number.isFinite(explicitTimeoutMs)
                ? Math.max(0, explicitTimeoutMs)
                : callTimeoutMs
            const pendingCall: PendingCall = { resolve: res, reject: rej }
            pending.set(id, pendingCall)
            socket.write(makeRequest(id, method, params))
            pendingCall.timer = timers.setTimeout(() => {
              if (!pending.delete(id)) return
              rej(new DaemonCallTimeoutError(method, requestTimeoutMs))
              // A caller-owned long-poll deadline is an expected outcome, not
              // evidence that the daemon connection is unhealthy.
              if (explicitTimeoutMs === undefined && ++timeouts >= 3) {
                log.warn?.(`${timeouts} consecutive timeouts, destroying connection`)
                socket.destroy()
              }
            }, requestTimeoutMs)
          }).then((v) => {
            timeouts = 0
            return v
          })
        },
        notify(method, params) {
          socket.write(makeNotification(method, params))
        },
        onNotification(handler) {
          notificationHandlers.push(handler)
        },
        close() {
          rejectPending(new Error("Connection closed"))
          socket.end()
        },
        socket,
      }

      resolvePromise(client)
    })
  })
}

// ---------------------------------------------------------------------------
// Auto-start daemon
// ---------------------------------------------------------------------------

export type ConnectOrStartOpts = {
  /** Path to the daemon entry script (required to spawn). */
  daemonScript?: string
  /** Extra args appended after `--socket <socketPath>` when spawning. */
  daemonArgs?: string[]
  /** Per-call request timeout once connected. */
  callTimeoutMs?: number
  /** If set, do not spawn a daemon when connection fails; throw instead. */
  noSpawn?: boolean
  /** Max reconnect attempts after spawning. Default 10. */
  maxStartupAttempts?: number
  /**
   * How many times to retry connecting to an *existing* daemon before deciding
   * it is dead and reclaiming/spawning. Default 10. See `connectExisting` for
   * why a single connect is unsafe.
   */
  connectAttempts?: number
  /** @internal test seam — override the connect primitive. */
  connectFn?: (path: string, o?: ConnectToDaemonOpts) => Promise<DaemonClient>
}

const OPERATOR_CAPABILITY_FD_ENV = "TRIBE_OPERATOR_CAPABILITY_FD"

function createOperatorCapabilityReader(): () => string | null {
  let read = false
  let capability: string | null = null
  return () => {
    if (read) return capability
    const raw = process.env[OPERATOR_CAPABILITY_FD_ENV]
    if (raw === undefined) {
      read = true
      return null
    }
    const fd = Number(raw)
    if (!Number.isSafeInteger(fd) || fd < 3) {
      throw new Error(`${OPERATOR_CAPABILITY_FD_ENV} must name an inherited fd >= 3, received ${JSON.stringify(raw)}`)
    }
    const loaded = readFileSync(fd, "utf8").trim()
    if (!loaded) throw new Error(`${OPERATOR_CAPABILITY_FD_ENV} contained an empty operator capability`)
    capability = loaded
    read = true
    return capability
  }
}

export type StandaloneDaemonSupervisorOpts = {
  daemonScript: string
  daemonArgs?: string[]
  operatorCapability?: string | null
  runtimePath?: string
  waitForPid?: number
}

function resolveWireCliScript(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  const candidates = [resolve(moduleDir, "cli.ts"), resolve(moduleDir, "cli.mjs"), resolve(moduleDir, "../cli.mjs")]
  const script = candidates.find((candidate) => existsSync(candidate))
  if (!script) {
    throw new Error(`connectOrStart: cannot locate the tribe-wire lifecycle owner beside ${moduleDir}`)
  }
  return script
}

/**
 * Where a DETACHED supervisor's own diagnostics go.
 *
 * A detached process has no terminal to inherit, so `stdio: "ignore"` meant the
 * supervisor could describe a dying daemon perfectly and nobody would ever read
 * it — the 2026-08-13 operator saw an empty log because there was no log. When
 * the operator has named a log file (the existing LOG_FILE convention, which
 * DEBUG_LOG maps onto), send the supervisor's stdout and stderr there.
 *
 * Returns "ignore" only when no log file was requested. Failing to honor one
 * that WAS requested is reported, never silently downgraded.
 */
function resolveSupervisorLogFd(env: NodeJS.ProcessEnv): number | "ignore" {
  const logPath = env.LOG_FILE ?? env.DEBUG_LOG
  if (!logPath) return "ignore"
  try {
    return openSync(logPath, "a")
  } catch (error) {
    log.warn?.(
      `cannot open ${logPath} for the daemon supervisor's log (${error instanceof Error ? error.message : String(error)}) — ` +
        `the supervisor will run, but nothing will record why a daemon generation dies`,
    )
    return "ignore"
  }
}

export function spawnStandaloneDaemonSupervisor(opts: StandaloneDaemonSupervisorOpts): ReturnType<typeof spawn> {
  const capability = opts.operatorCapability?.trim() || null
  const env = sanitizeStandaloneDaemonEnvironment(process.env)
  delete env[OPERATOR_CAPABILITY_FD_ENV]
  delete env.TRIBE_OPERATOR_CAPABILITY
  if (capability) env[OPERATOR_CAPABILITY_FD_ENV] = "3"
  const supervisorArgs = [
    resolveWireCliScript(),
    "__standalone-supervisor",
    ...(opts.waitForPid === undefined ? [] : ["--wait-for-pid", String(opts.waitForPid)]),
    "--",
    opts.daemonScript,
    ...(opts.daemonArgs ?? []),
  ]
  const logFd = resolveSupervisorLogFd(process.env)
  const child = spawn(opts.runtimePath ?? process.execPath, supervisorArgs, {
    detached: true,
    stdio: capability ? ["ignore", logFd, logFd, "pipe"] : ["ignore", logFd, logFd],
    env,
  })
  // The child holds its own duplicate of the descriptor from here on.
  if (logFd !== "ignore") closeSync(logFd)
  if (capability) {
    const capabilityPipe = child.stdio[3]
    if (!capabilityPipe || !("end" in capabilityPipe)) {
      child.kill()
      throw new Error("daemon spawn did not expose the operator capability pipe")
    }
    capabilityPipe.on("error", (error) => log.warn?.(`operator capability pipe failed: ${error.message}`))
    capabilityPipe.end(capability)
  }
  child.unref()
  return child
}

function spawnLifecycleOwnerWithOperatorCapability(
  script: string,
  args: string[],
  readOperatorCapability: () => string | null,
): ReturnType<typeof spawn> {
  return spawnStandaloneDaemonSupervisor({
    daemonScript: script,
    daemonArgs: args,
    operatorCapability: readOperatorCapability(),
  })
}

/**
 * Connect to an *existing* daemon, retrying on a transient ECONNREFUSED.
 *
 * Why this exists: a single connect cannot distinguish "stale socket, daemon
 * dead" from "live daemon, momentarily unreachable". On macOS/BSD a connect to
 * a LIVE Unix-domain socket returns ECONNREFUSED when the accept backlog is
 * full; the same transient refusal happens during the daemon's hot-reload
 * re-exec window and while a socket is being churned by a mis-fired respawn.
 * Treating that refusal as "dead" is exactly what made `connectOrStart` unlink
 * a live daemon's socket and spawn a competitor — the split-brain that left
 * every pane reporting "active-pane-no-tribe" / "no alive hats".
 *
 * Retrying a few times with backoff connects to a live-but-busy daemon; only a
 * genuinely dead/stale socket keeps refusing for the whole window. ENOENT (no
 * socket file at all) short-circuits to `null` on the first try — there is
 * nothing to wait for, the caller should spawn. Non-refusal errors propagate.
 *
 * Returns a connected client, or `null` when the socket stays unreachable.
 */
export async function connectExisting(
  socketPath: string,
  opts?: {
    callTimeoutMs?: number
    /** Total connect attempts before giving up. Default 10. */
    attempts?: number
    /** @internal test seam — override the connect primitive. */
    connectFn?: (path: string, o?: ConnectToDaemonOpts) => Promise<DaemonClient>
    /** @internal test seam — override the backoff delay. */
    delayFn?: (ms: number) => Promise<void>
  },
): Promise<DaemonClient | null> {
  const attempts = Math.max(1, opts?.attempts ?? 10)
  const connectFn = opts?.connectFn ?? connectToDaemon
  const delayFn = opts?.delayFn ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await connectFn(socketPath, { callTimeoutMs: opts?.callTimeoutMs })
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code
      // No socket file → daemon truly absent; don't burn the retry budget.
      if (code === "ENOENT") return null
      // Anything other than "refused" is not the transient case → surface it.
      if (code !== "ECONNREFUSED") throw err
      // Refused: stale OR live-but-busy. Back off and retry before deciding.
      if (attempt < attempts - 1) await delayFn(Math.min(50 * 2 ** attempt, 1000))
    }
  }
  return null
}

async function connectOrStartWithCapability(
  socketPath: string,
  opts: ConnectOrStartOpts | undefined,
  readOperatorCapability: () => string | null,
): Promise<DaemonClient> {
  // Connect to an existing daemon, retrying transient refusals so we never
  // mistake a live-but-busy daemon for a dead one (see `connectExisting`).
  const existing = await connectExisting(socketPath, {
    callTimeoutMs: opts?.callTimeoutMs,
    attempts: opts?.connectAttempts,
    connectFn: opts?.connectFn,
  })
  if (existing) return existing

  if (opts?.noSpawn) {
    throw Object.assign(new Error(`connectOrStart: no reachable daemon at ${socketPath} (noSpawn)`), {
      code: "ECONNREFUSED",
    })
  }

  // No daemon answered after retries. A socket FILE may still be present —
  // stale, or owned by a daemon that recovered in the last few ms. NEVER unlink
  // a socket a live daemon owns: that orphans every other client and forces the
  // split-brain spawn this whole function exists to avoid. Probe once more;
  // only reclaim a confirmed-dead file.
  if (existsSync(socketPath)) {
    if (await isSocketAlive(socketPath)) {
      const revived = await connectExisting(socketPath, {
        callTimeoutMs: opts?.callTimeoutMs,
        attempts: 3,
        connectFn: opts?.connectFn,
      })
      if (revived) return revived
      // Alive at the kernel level but no client handshake completes — surface
      // rather than destroy a live socket and spawn a competitor.
      throw Object.assign(
        new Error(`connectOrStart: socket ${socketPath} is alive but unreachable; refusing to unlink a live daemon`),
        { code: "EBUSY" },
      )
    }
    try {
      unlinkSync(socketPath)
    } catch {
      /* ignore */
    }
  }

  const socketDir = dirname(socketPath)
  if (!existsSync(socketDir)) mkdirSync(socketDir, { recursive: true })

  const script = opts?.daemonScript
  if (!script) {
    throw new Error(`connectOrStart: no daemon at ${socketPath} and no daemonScript provided to spawn one`)
  }

  // 21052 — stale-pin auto-spawn gate. During the d463c5b rollout, this exact
  // fallback resurrected a retired daemon pin from a stale source tree the
  // moment the old daemon was terminated for replacement. Refuse a spawn whose
  // source is provably older than the last pin that bound this socket; the
  // refusal leaves the caller in the normal degraded/retry path so a current
  // daemon (or a current adapter's spawn) wins instead.
  const pinGate = evaluateSpawnSourceForScript(script, socketPath)
  if (!pinGate.allow) {
    throw Object.assign(new Error(`connectOrStart: ${pinGate.reason}`), { code: "ESTALEPIN" })
  }
  if (pinGate.reason) log.warn?.(pinGate.reason)

  const args = ["--socket", socketPath, ...(opts?.daemonArgs ?? [])]
  spawnLifecycleOwnerWithOperatorCapability(script, args, readOperatorCapability)

  const maxAttempts = opts?.maxStartupAttempts ?? 10
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise<void>((r) => setTimeout(r, Math.min(100 * 2 ** attempt, 2000)))
    const client = await connectExisting(socketPath, {
      callTimeoutMs: opts?.callTimeoutMs,
      attempts: 1,
      connectFn: opts?.connectFn,
    })
    if (client) return client
  }

  throw new Error(`Failed to connect to daemon at ${socketPath} after starting it`)
}

export function connectOrStart(socketPath: string, opts?: ConnectOrStartOpts): Promise<DaemonClient> {
  return connectOrStartWithCapability(socketPath, opts, createOperatorCapabilityReader())
}

// ---------------------------------------------------------------------------
// Reconnecting client
// ---------------------------------------------------------------------------

export type ReconnectingClientOpts = {
  socketPath: string
  /** Called after each successful (re)connect — use for register/subscribe */
  onConnect?: (client: DaemonClient) => Promise<void>
  /** Called on disconnect (before reconnect attempt) */
  onDisconnect?: () => void
  /** Called on successful reconnect */
  onReconnect?: () => void
  /** Called once after the bounded reconnect loop exhausts every attempt. */
  onReconnectExhausted?: (error: unknown, attempts: number) => void
  /** Max reconnect attempts (default: 30) */
  maxAttempts?: number
  /** Forwarded to connectOrStart on each (re)connect */
  callTimeoutMs?: number
  /** Keep this host connect-only; never create a daemon during initial connect or reconnect. */
  noSpawn?: boolean
  daemonScript?: string
  daemonArgs?: string[]
  maxStartupAttempts?: number
}

/**
 * Tags a connectAndRegister() failure as "the transport connected fine but
 * onConnect's registration handshake was cut off by a TRANSPORT-continuity
 * problem" — as opposed to either (a) a failure to establish the transport
 * at all, or (b) the daemon staying reachable and making a deliberate
 * decision to refuse the request. Only the tagged case is safe to retry on
 * the INITIAL connect (see connectInitialWithRetry below): retrying (a)
 * cannot succeed with the same socketPath/opts, and retrying (b) gets the
 * identical deliberate refusal every time (see isDeliberateDaemonRefusal).
 */
class RegistrationError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
  }
}

/**
 * True when `error` is a well-formed JSON-RPC error response the daemon
 * itself sent back — see connectToDaemon's response handling:
 * `p.reject(Object.assign(new Error(msg.error.message), { code:
 * msg.error.code, ... }))`. JSON-RPC 2.0 requires `error.code` to be an
 * integer, so a NUMERIC `.code` only ever comes from a daemon that received
 * the request and chose to refuse it (a name conflict, a permission
 * refusal, a protocol version the caller must renegotiate before retrying
 * — stdio-adapter.ts's `isPersonaNameConflictError`/protocol-mismatch
 * handling both key off exactly this shape). Retrying an IDENTICAL request
 * against that gets the identical refusal every time, so it must propagate
 * immediately — same as before this fix — not be swallowed into a silent
 * retry loop. A genuine transport-continuity failure carries no numeric
 * code: Node system errors use STRING codes ("ECONNREFUSED"), a call
 * timeout's code is the string "TRIBE_DAEMON_CALL_TIMEOUT", and
 * connectToDaemon's own close-triggered rejection ("Connection closed")
 * carries no code at all.
 */
function isDeliberateDaemonRefusal(error: unknown): boolean {
  return typeof (error as { code?: unknown } | null)?.code === "number"
}

/**
 * Create a client that auto-reconnects on disconnect.
 * Wraps connectOrStart + register/subscribe in a single reusable pattern.
 *
 * Notification handlers registered via `client.onNotification(handler)` are
 * persistent — they're replayed on every successful reconnect, so callers
 * never need to re-subscribe.
 *
 * The INITIAL connect retries a registration-handshake failure on an
 * already-established transport, up to `maxAttempts` with the same backoff
 * a reconnect uses, instead of rejecting outright on the first race lost —
 * see the 21089 comment on connectInitialWithRetry. A transport failure (no
 * daemon reachable and nothing to spawn) still rejects immediately.
 */
export async function createReconnectingClient(opts: ReconnectingClientOpts): Promise<DaemonClient> {
  const {
    socketPath,
    onConnect,
    onDisconnect,
    onReconnect,
    onReconnectExhausted,
    maxAttempts = 30,
    callTimeoutMs,
    noSpawn,
    daemonScript,
    daemonArgs,
    maxStartupAttempts,
  } = opts
  const startOpts: ConnectOrStartOpts = { callTimeoutMs, noSpawn, daemonScript, daemonArgs, maxStartupAttempts }
  // Read the inherited descriptor at most once, then carry the capability in
  // this reconnecting client's closure. Every later daemon spawn gets a fresh
  // anonymous pipe, so a consumed/closed launch fd cannot silently strip
  // operator authority after a crash or restart.
  const readOperatorCapability = createOperatorCapabilityReader()

  async function connectAndRegister(): Promise<DaemonClient> {
    const candidate = await connectOrStartWithCapability(socketPath, startOpts, readOperatorCapability)
    try {
      if (onConnect) await onConnect(candidate)
    } catch (error) {
      candidate.close()
      throw isDeliberateDaemonRefusal(error) ? error : new RegistrationError(error)
    }
    return candidate
  }

  // 21089 — the initial connect used to be a single unretried
  // connectAndRegister(): if the transport died mid-registration (a real
  // production race — onConnect commonly performs several sequential round
  // trips, e.g. stdio-adapter.ts's register then tribe.members, so there is
  // a genuine, contention-widened window), the whole function rejected
  // outright and setupReconnect() below never ran even once. setupReconnect
  // installs the ONLY listener that ever drives a reconnect, and —
  // transitively, via onDisconnect() — the only thing that arms the
  // reconnectWatchdog backstop, so a lost race on the very first
  // registration permanently orphaned the client: no retry, no reconnect,
  // no watchdog, ever again, even though the socket's own 'close' event
  // fires correctly at the OS level the whole time. Reproduced
  // deterministically on task/wire-reconnect-close-cto (root-caused from
  // task/ci-deflake-version-skew-cto's instrumented harness, which first
  // surfaced this as a ~14%-of-runs CI flake under 4-core CPU contention):
  // destroying the accepted socket while onConnect's second round trip is
  // in flight rejects createReconnectingClient in ~7ms flat, with the raw
  // socket's 'end'/'close' events observed firing on schedule throughout —
  // the bug was never "close fails to fire", it was "nothing is listening
  // yet when it does."
  //
  // Retrying a REGISTRATION failure exactly like a reconnect (same bounded
  // backoff, same maxAttempts) closes the gap. A TRANSPORT failure (no
  // daemon reachable, nothing to spawn) is deliberately NOT retried here —
  // it propagates immediately, unchanged from before: retrying with the
  // same options cannot succeed differently, and the "loud but soft"
  // solo-degrade UX (km 19851, stdio-adapter-degrade.test.ts) depends on
  // that fast, one-time signal rather than a long silent retry storm.
  async function connectInitialWithRetry(): Promise<DaemonClient> {
    const timers = createTimers(new AbortController().signal)
    let lastError: unknown = new Error("Connect exhausted without an attempt")
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Attempt 0 never delays — the overwhelmingly common case (connects
      // on the first try) must not pay an artificial startup tax.
      if (attempt > 0) await timers.delay(Math.min(500 * 2 ** (attempt - 1), 10_000))
      try {
        return await connectAndRegister()
      } catch (error) {
        if (!(error instanceof RegistrationError)) throw error
        lastError = error.cause
        log.debug?.(`Initial registration attempt ${attempt + 1} failed`)
      }
    }
    throw lastError
  }

  let current = await connectInitialWithRetry()
  let closed = false
  let reconnectAc: AbortController | null = null
  // Persistent notification handlers — replayed onto each new connection
  const notificationHandlers: Array<(method: string, params?: Record<string, unknown>) => void> = []

  // task/wire-postreg-close-cto — setupReconnect used to ONLY attach a 'close' listener, on the
  // assumption that the socket is still open at the moment it runs. That
  // assumption breaks for the SAME connection setupReconnect is meant to
  // watch: connectAndRegister() awaits onConnect(candidate), and a
  // real-world onConnect commonly makes further round trips after
  // registration succeeds (e.g. stdio-adapter.ts's post-register
  // tribe.members call). If the transport dies DURING one of those calls,
  // connectToDaemon's own close-triggered rejectPending is what unblocks
  // the pending call (and, transitively, onConnect) — so the 'close' event
  // this function needs to observe fires and finishes dispatching to its
  // (already-attached) listeners BEFORE connectAndRegister/onConnect ever
  // returns, which is the earliest point setupReconnect can run. Attaching
  // a listener after an event already fired never sees it — EventEmitters
  // don't replay history — so the reconnect loop silently never started.
  // Reproduced deterministically on task/wire-postreg-close-cto.
  //
  // The fix: treat "the socket is already destroyed by the time we get
  // here" as equivalent to "close just fired" and run the identical
  // handler immediately, instead of only ever reacting to a future event.
  const setupReconnect = () => {
    const handleClose = () => {
      if (closed) return
      onDisconnect?.()
      reconnectAc?.abort()
      reconnectAc = new AbortController()
      const timers = createTimers(reconnectAc.signal)
      void (async () => {
        let lastError: unknown = new Error("Reconnect exhausted without an attempt")
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          if (closed) return
          const ms = Math.min(500 * 2 ** attempt, 10_000)
          try {
            await timers.delay(ms)
          } catch {
            return // Aborted (closed or new reconnect superseded)
          }
          if (closed) return
          try {
            const candidate = await connectAndRegister()
            current = candidate
            for (const h of notificationHandlers) candidate.onNotification(h)
            setupReconnect()
            onReconnect?.()
            return
          } catch (error) {
            // Reconnects retry EITHER failure kind uniformly (unchanged
            // from before RegistrationError existed) — only the initial
            // connect distinguishes them. Unwrap so the reported error
            // matches what onConnect/connectOrStart actually threw.
            lastError = error instanceof RegistrationError ? error.cause : error
            log.debug?.(`Reconnect attempt ${attempt + 1} failed`)
          }
        }
        if (onReconnectExhausted) onReconnectExhausted(lastError, maxAttempts)
        else log.error?.(`Failed to reconnect after ${maxAttempts} attempts`)
      })()
    }
    // Synchronous check-then-attach, no `await` between them: `destroyed`
    // flips to true synchronously the instant destroy() runs (Node/Bun both
    // guarantee this), strictly before 'close' is dispatched, so there is no
    // gap in which the socket could transition between the check and the
    // listener registration below.
    if (current.socket.destroyed) {
      handleClose()
      return
    }
    current.socket.on("close", handleClose)
  }
  setupReconnect()

  return new Proxy(current, {
    get(_, prop) {
      if (prop === "call")
        return (...args: Parameters<DaemonClient["call"]>) => {
          // 22994 — after a disconnect, `current` still names the retired
          // client until the bounded reconnect loop installs its successor.
          // Writing a request to that destroyed socket creates a pending call
          // that can only expire at the generic 10s deadline. Fail before the
          // write so MCP callers receive the reconnect state immediately and
          // can retry. Never replay a call that was written before transport
          // death: a mutating request may already have committed remotely.
          if (current.socket.destroyed) {
            return Promise.reject(new Error("daemon connection closed; reconnecting"))
          }
          return current.call(...args)
        }
      if (prop === "close")
        return () => {
          closed = true
          reconnectAc?.abort()
          current.close()
          current.socket.unref()
        }
      if (prop === "onNotification")
        return (handler: (method: string, params?: Record<string, unknown>) => void) => {
          notificationHandlers.push(handler)
          current.onNotification(handler)
        }
      return (current as Record<string | symbol, unknown>)[prop]
    },
  }) as DaemonClient
}

// ---------------------------------------------------------------------------
// Liveness probes
// ---------------------------------------------------------------------------

/** True iff the socket accepts a TCP-style connection. */
export function isSocketAlive(socketPath: string): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = createConnection(socketPath)
    let settled = false
    const done = (alive: boolean) => {
      if (settled) return
      settled = true
      try {
        socket.destroy()
      } catch {
        /* ignore */
      }
      resolvePromise(alive)
    }
    socket.once("connect", () => done(true))
    socket.once("error", () => done(false))
  })
}

/**
 * Liveness probe with retry — the safe counterpart to `isSocketAlive`.
 *
 * A single `isSocketAlive` probe returns false on a transient ECONNREFUSED
 * (full accept backlog, hot-reload re-exec window, socket mid-churn). Callers
 * that act DESTRUCTIVELY on a "dead" verdict — e.g. the daemon unlinking a
 * socket it believes is stale before binding its own — must not trust a single
 * probe. Retrying biases toward detecting life: returns true as soon as any
 * probe connects, and only returns false after every attempt refuses.
 */
export async function waitForSocketAlive(
  socketPath: string,
  opts?: { attempts?: number; delayMs?: number; aliveFn?: (p: string) => Promise<boolean> },
): Promise<boolean> {
  const attempts = Math.max(1, opts?.attempts ?? 5)
  const aliveFn = opts?.aliveFn ?? isSocketAlive
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await aliveFn(socketPath)) return true
    if (attempt < attempts - 1) {
      const ms = opts?.delayMs ?? Math.min(50 * 2 ** attempt, 1000)
      await new Promise<void>((r) => setTimeout(r, ms))
    }
  }
  return false
}
