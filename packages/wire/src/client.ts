/**
 * Daemon client — connect to a Unix-socket JSON-RPC daemon, send requests
 * and notifications, receive responses and pushed notifications.
 *
 * Three layers, lowest to highest:
 *
 *  1. `connectToDaemon(socketPath, opts?)` — plain connect; rejects on
 *     ECONNREFUSED / ENOENT. Per-call timeout configurable.
 *  2. `connectOrStart(socketPath, opts)` — connect; if no daemon, spawn the
 *     supplied `daemonScript` as a detached child and retry with
 *     exponential backoff.
 *  3. `createReconnectingClient(opts)` — proxy that wraps a current client
 *     and transparently reconnects (via connectOrStart) on socket close,
 *     replaying registered notification handlers.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs"
import { createConnection, type Socket } from "node:net"
import { spawn } from "node:child_process"
import { dirname } from "node:path"
import { createLogger } from "loggily"
import { createLineParser } from "./parser.ts"
import { evaluateSpawnSourceForScript } from "./lib/spawn-pin-gate.ts"
import { isNotification, isResponse, makeNotification, makeRequest } from "./rpc.ts"
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
              rej(new Error(`Request ${method} timed out`))
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

function spawnDaemonWithOperatorCapability(
  script: string,
  args: string[],
  readOperatorCapability: () => string | null,
): ReturnType<typeof spawn> {
  const capability = readOperatorCapability()
  const env = { ...process.env }
  delete env[OPERATOR_CAPABILITY_FD_ENV]
  delete env.TRIBE_OPERATOR_CAPABILITY
  if (capability) env[OPERATOR_CAPABILITY_FD_ENV] = "3"
  const child = spawn(process.execPath, [script, ...args], {
    detached: true,
    stdio: capability ? ["ignore", "ignore", "ignore", "pipe"] : "ignore",
    env,
  })
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
  spawnDaemonWithOperatorCapability(script, args, readOperatorCapability)

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
  daemonScript?: string
  daemonArgs?: string[]
  maxStartupAttempts?: number
}

/**
 * Create a client that auto-reconnects on disconnect.
 * Wraps connectOrStart + register/subscribe in a single reusable pattern.
 *
 * Notification handlers registered via `client.onNotification(handler)` are
 * persistent — they're replayed on every successful reconnect, so callers
 * never need to re-subscribe.
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
    daemonScript,
    daemonArgs,
    maxStartupAttempts,
  } = opts
  const startOpts: ConnectOrStartOpts = { callTimeoutMs, daemonScript, daemonArgs, maxStartupAttempts }
  // Read the inherited descriptor at most once, then carry the capability in
  // this reconnecting client's closure. Every later daemon spawn gets a fresh
  // anonymous pipe, so a consumed/closed launch fd cannot silently strip
  // operator authority after a crash or restart.
  const readOperatorCapability = createOperatorCapabilityReader()
  let current = await connectOrStartWithCapability(socketPath, startOpts, readOperatorCapability)
  if (onConnect) await onConnect(current)
  let closed = false
  let reconnectAc: AbortController | null = null
  // Persistent notification handlers — replayed onto each new connection
  const notificationHandlers: Array<(method: string, params?: Record<string, unknown>) => void> = []

  const setupReconnect = () => {
    current.socket.on("close", () => {
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
            current = await connectOrStartWithCapability(socketPath, startOpts, readOperatorCapability)
            if (onConnect) await onConnect(current)
            for (const h of notificationHandlers) current.onNotification(h)
            setupReconnect()
            onReconnect?.()
            return
          } catch (error) {
            lastError = error
            log.debug?.(`Reconnect attempt ${attempt + 1} failed`)
          }
        }
        if (onReconnectExhausted) onReconnectExhausted(lastError, maxAttempts)
        else log.error?.(`Failed to reconnect after ${maxAttempts} attempts`)
      })()
    })
  }
  setupReconnect()

  return new Proxy(current, {
    get(_, prop) {
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
