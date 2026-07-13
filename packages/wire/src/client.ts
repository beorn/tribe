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

import { existsSync, mkdirSync, unlinkSync } from "node:fs"
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

/** Per-call overrides for `DaemonClient.call`. */
export type DaemonCallOpts = {
  /**
   * Override the per-call request timeout (ms) for THIS call only. A timeout on
   * a call that passed an explicit `timeoutMs` is treated as an INTENTIONAL
   * long-poll expiry (e.g. `tribe.inbox.wait`): it does NOT count toward the
   * consecutive-timeout connection-destroy policy. Calls that rely on the
   * default `callTimeoutMs` keep the destroy-on-3-timeouts behavior.
   */
  timeoutMs?: number
}

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

export type ConnectToDaemonOpts = {
  /** Per-call request timeout. Default: 10000 ms. */
  callTimeoutMs?: number
}

export function connectToDaemon(socketPath: string, opts?: ConnectToDaemonOpts): Promise<DaemonClient> {
  const callTimeoutMs = opts?.callTimeoutMs ?? 10_000
  return new Promise((resolvePromise, reject) => {
    const socket = createConnection(socketPath)
    const pending = new Map<number | string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
    const notificationHandlers: Array<(method: string, params?: Record<string, unknown>) => void> = []
    let nextId = 1

    const ac = new AbortController()
    const timers = createTimers(ac.signal)

    function rejectPending(err: Error): void {
      for (const [, p] of pending) p.reject(err)
      pending.clear()
      ac.abort()
    }

    const parse = createLineParser((msg) => {
      if (isResponse(msg)) {
        const p = pending.get(msg.id)
        if (p) {
          pending.delete(msg.id)
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
        call(method, params, opts) {
          // A caller-specified per-call timeout is an intentional deadline (a
          // long-poll like tribe.inbox.wait). Its expiry is NOT evidence the
          // daemon is dead, so it must not feed the 3-strike destroy counter —
          // only default-timeout expiries do (see below).
          const explicitTimeout = opts?.timeoutMs !== undefined
          const perCallTimeoutMs = opts?.timeoutMs ?? callTimeoutMs
          return new Promise((res, rej) => {
            const id = nextId++
            pending.set(id, { resolve: res, reject: rej })
            socket.write(makeRequest(id, method, params))
            timers.setTimeout(() => {
              if (!pending.delete(id)) return
              rej(new Error(`Request ${method} timed out`))
              if (explicitTimeout) return
              if (++timeouts >= 3) {
                log.warn?.(`${timeouts} consecutive timeouts, destroying connection`)
                socket.destroy()
              }
            }, perCallTimeoutMs)
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

export async function connectOrStart(socketPath: string, opts?: ConnectOrStartOpts): Promise<DaemonClient> {
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
  const child = spawn(process.execPath, [script, ...args], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  })
  child.unref()

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

// ---------------------------------------------------------------------------
// Retry-on-reconnect policy (20703 safe-reload)
// ---------------------------------------------------------------------------

/**
 * Pure-snapshot tribe.* methods: read-only, no cursor advance, no side effect
 * (the per-call presence touch the daemon does for every tool call is
 * idempotent). Re-issuing one after a reconnect is always safe.
 */
const RETRIABLE_SNAPSHOT_METHODS = new Set([
  "tribe.members",
  "tribe.health",
  "tribe.pending",
  "tribe.lifecycle",
  "tribe.debug",
])

/**
 * A `tribe.fetch` is a SNAPSHOT (safe to blind-retry) only when it reads
 * without advancing the durable inbox cursor: an `ids` lookup, or a
 * `with`/`from`/`to` peer filter, and never an explicit `advance:true` or a
 * `since`-driven drain. The DEFAULT drain (none of those) advances the cursor
 * AND acknowledges the actionable mailbox server-side — even if the response is
 * lost — so a silent retry would skip rows (the NO-SILENT-ERRORS / message-loss
 * class). `since` is treated as non-snapshot conservatively: it is the draining
 * idiom and pairs with `advance`; excluding it only forgoes a retry (safe),
 * whereas mis-including it could drop rows. Mirrors daemon `handleFetch`.
 */
function isSnapshotFetch(params?: Record<string, unknown>): boolean {
  if (!params) return false
  if (params.advance === true) return false
  if (params.since !== undefined) return false
  const hasIds = Array.isArray(params.ids) && params.ids.length > 0
  const hasPeer =
    (typeof params.with === "string" && params.with.length > 0) ||
    (typeof params.from === "string" && params.from.length > 0) ||
    (typeof params.to === "string" && params.to.length > 0)
  return hasIds || hasPeer
}

/**
 * Whether a tribe.* RPC may be transparently re-issued ONCE after a reconnect
 * (see `createReconnectingClient`). True for pure snapshots, snapshot-mode
 * fetch, and a `tribe.send` that carries a client-minted `idempotencyKey` (the
 * daemon dedups by key so a retry cannot double-deliver). Everything else —
 * default-drain fetch, register/join/rename, reload/repair/filter, un-keyed
 * send, and long-poll `tribe.inbox.wait` — is NOT retriable and surfaces the
 * failure to the caller.
 */
export function isRetriableTribeCall(method: string, params?: Record<string, unknown>): boolean {
  if (RETRIABLE_SNAPSHOT_METHODS.has(method)) return true
  if (method === "tribe.fetch") return isSnapshotFetch(params)
  if (method === "tribe.send") return typeof params?.idempotencyKey === "string" && params.idempotencyKey.length > 0
  return false
}

/** True for errors that mean the transport died (vs. a real RPC error). */
function isConnectionClosed(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  if (/Connection closed/i.test(err.message)) return true
  const code = (err as NodeJS.ErrnoException).code
  return code === "EPIPE" || code === "ECONNRESET" || code === "ERR_STREAM_DESTROYED"
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
    maxAttempts = 30,
    callTimeoutMs,
    daemonScript,
    daemonArgs,
    maxStartupAttempts,
  } = opts
  const startOpts: ConnectOrStartOpts = { callTimeoutMs, daemonScript, daemonArgs, maxStartupAttempts }
  let current = await connectOrStart(socketPath, startOpts)
  if (onConnect) await onConnect(current)
  let closed = false
  let connected = true
  let reconnectAc: AbortController | null = null
  // Persistent notification handlers — replayed onto each new connection
  const notificationHandlers: Array<(method: string, params?: Record<string, unknown>) => void> = []

  // 20703 safe-reload: callers waiting for the transport to come back after a
  // disconnect. `call` uses this to bound a safe-call retry by the call's own
  // deadline. A settled waiter clears its own timer and removes itself.
  type ReconnectWaiter = { resolve: () => void; reject: (e: Error) => void }
  const reconnectWaiters: Set<ReconnectWaiter> = new Set()
  const drainWaiters = (settle: (w: ReconnectWaiter) => void) => {
    for (const w of [...reconnectWaiters]) settle(w)
  }
  const waitForReconnect = (deadlineMs: number): Promise<void> => {
    if (connected) return Promise.resolve()
    if (closed) return Promise.reject(new Error("Connection closed"))
    return new Promise<void>((resolve, reject) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const waiter: ReconnectWaiter = {
        resolve: () => finish(resolve),
        reject: (e: Error) => finish(() => reject(e)),
      }
      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        reconnectWaiters.delete(waiter)
        fn()
      }
      reconnectWaiters.add(waiter)
      timer = setTimeout(
        () => finish(() => reject(new Error("Request timed out waiting for reconnect"))),
        Math.max(0, deadlineMs - Date.now()),
      )
      ;(timer as { unref?: () => void }).unref?.()
    })
  }

  const setupReconnect = () => {
    current.socket.on("close", () => {
      if (closed) return
      connected = false
      onDisconnect?.()
      reconnectAc?.abort()
      reconnectAc = new AbortController()
      const timers = createTimers(reconnectAc.signal)
      void (async () => {
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
            current = await connectOrStart(socketPath, startOpts)
            if (onConnect) await onConnect(current)
            for (const h of notificationHandlers) current.onNotification(h)
            setupReconnect()
            connected = true
            drainWaiters((w) => w.resolve())
            onReconnect?.()
            return
          } catch {
            log.debug?.(`Reconnect attempt ${attempt + 1} failed`)
          }
        }
        log.error?.(`Failed to reconnect after ${maxAttempts} attempts`)
        // Fail loud: unblock any deadline-waiting safe-call retries.
        drainWaiters((w) => w.reject(new Error(`Failed to reconnect after ${maxAttempts} attempts`)))
      })()
    })
  }
  setupReconnect()

  // 20703 safe-reload: transparently re-issue a SAFE call ONCE across a
  // reconnect so a daemon restart costs the caller latency, not an error. A
  // call that fails with a connection-closed signal (or is issued while the
  // transport is already down) waits for the reconnect — bounded by the call's
  // own deadline (per-call `timeoutMs`, else `callTimeoutMs`, else 10s) — and
  // re-issues exactly once on the new connection. Only `isRetriableTribeCall`
  // methods qualify; everything else surfaces the failure unchanged.
  const callWithRetry = (
    method: string,
    params?: Record<string, unknown>,
    callOpts?: DaemonCallOpts,
  ): Promise<unknown> => {
    if (!isRetriableTribeCall(method, params)) return current.call(method, params, callOpts)
    const budgetMs = callOpts?.timeoutMs ?? callTimeoutMs ?? 10_000
    const deadlineMs = Date.now() + budgetMs
    const issue = () => current.call(method, params, callOpts)
    const attempt = connected ? issue() : waitForReconnect(deadlineMs).then(issue)
    return attempt.catch((err: unknown) => {
      if (closed || !isConnectionClosed(err)) throw err
      // The transport died — wait for the reconnect and re-issue ONCE.
      return waitForReconnect(deadlineMs).then(issue)
    })
  }

  return new Proxy(current, {
    get(_, prop) {
      if (prop === "call") return callWithRetry
      if (prop === "close")
        return () => {
          closed = true
          reconnectAc?.abort()
          drainWaiters((w) => w.reject(new Error("Connection closed")))
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
