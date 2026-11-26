/**
 * withBroadcast — owns the broadcast pipeline that delivers messages from
 * SQLite (via the messageTap) to connected sockets.
 *
 * Three responsibilities:
 *
 *   1. Per-session delivery filter (focus / normal / ambient + snooze) and
 *      per-client coalescing into batched wakeup notifications. The durable
 *      message log is the bus; push only tells clients to fetch it.
 *   2. Ad-hoc `broadcastNotification(method, params, exclude)` — writes a
 *      JSON-RPC notification to every connected socket (excluding `exclude`).
 *   3. `broadcastLog(msg, type)` — admits explicit daemon health diagnostics
 *      through a bounded, model-safe persistence gate.
 *
 * The broadcast scrubber (regex + optional Haiku rewrite) lives in
 * `broadcast-scrubber.ts` so it stays unit-testable independently of the
 * daemon plumbing.
 *
 * Raw loggily warn/error records intentionally stay on loggily's local sinks.
 * They do not automatically re-enter Tribe's durable coordination journal.
 * Callers that need a fleet-visible health diagnostic use `Broadcast.log`,
 * whose window state and final suppression summary are owned by this scope.
 */

import { createLogger } from "loggily"
import { settlesRequestOpenedBy, type MessageInsertedInfo } from "../context.ts"
import { activityFromMessage, writeActivity } from "../activity-log.ts"
import { createCoalescer, type PendingBroadcast } from "../broadcast-coalescer.ts"
import { readCatchUp } from "../catch-up-on-attach.ts"
import { ACTIONABLE_TYPES_SET } from "../database.ts"
import { createHealthLogAdmission } from "../health-log-admission.ts"
import { deriveReplyHint, sendMessage, type MessageKind, type ReplyHint } from "../messaging.ts"
import { makeNotification } from "tribe-wire/lib/socket"
import { hasInjectionTrigger, rewriteViaHaiku, scrubInjectionShape } from "../broadcast-scrubber.ts"
import type { BaseTribe } from "./base.ts"
import type { WithClientRegistry } from "./with-client-registry.ts"
import type { WithDaemonContext } from "./with-daemon-context.ts"
import type { WithDatabase } from "./with-database.ts"

const log = createLogger("tribe:broadcast")

function singleEventNotification(ev: PendingBroadcast): string {
  return makeNotification("wakeup", {
    latest_seq: ev.rowid,
    message_id: ev.id,
    count: 1,
    topic: ev.topic,
  })
}

function batchedNotification(events: PendingBroadcast[], dropped: number): string {
  const last = events[events.length - 1]
  return makeNotification("wakeup", {
    latest_seq: last?.rowid ?? null,
    message_id: last?.id ?? null,
    count: events.length + dropped,
    dropped,
    topic: last?.topic ?? null,
  })
}

function broadcastBatchMs(): number {
  const raw = process.env.TRIBE_BROADCAST_BATCH_MS
  if (raw === undefined) return 400
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : 400
}

// ---------------------------------------------------------------------------
// Per-session delivery filter — unified focus mode + time-bounded mute +
// per-topic glob list. Reads the filter shape that
// `tribe.filter` writes (sessions.filter_mode/filter_until/filter_mute).
// ---------------------------------------------------------------------------

type SessionFilter = {
  filter_mode: string
  filter_until: number | null
  filter_mute: string | null
}

export function shouldDeliver(
  info: {
    kind: MessageKind
    type: string
    replyHint: ReplyHint
    topic: string | null
    settlesOwnRequest: boolean
    isIncident?: boolean
    wakesOwner?: boolean
    attentionRequired?: boolean
  },
  filter: SessionFilter | undefined,
): boolean {
  // Quiet observations are journal/tracker state, even without a session filter.
  if (info.isIncident === true && info.wakesOwner !== true) return false
  // Incident edges interrupt their owner regardless of the ordinary notification diet.
  if (info.wakesOwner === true) return true
  if (!filter) return true // No session row yet — default-allow
  const mode = filter.filter_mode || "normal"
  if (mode === "ambient") return true
  if (mode === "focus") {
    // Only the canonical actionable classes wake the seat. Plain direct
    // notify/response traffic is informational even though its legacy reply
    // hint is "yes". Two narrow exceptions:
    //  1. A reply that settles a request this seat opened (G9 self-inbox P0).
    //  2. A verified persona fleet broadcast classified as attention_required
    //     (#38796, @cto 7767f5fe) — broadcast-only so direct ref-bound statuses
    //     stay quiet (#29535).
    //
    // Focus mode suppresses push wakeups for ambient rows while keeping direct
    // rows fetchable on the recipient's next inbox drain (database.ts:3074-3081,
    // pinned at delivery-policy-parity.test.ts:158).
    return (
      ACTIONABLE_TYPES_SET.has(info.type) ||
      info.settlesOwnRequest ||
      (info.kind === "broadcast" && info.attentionRequired === true)
    )
  }
  if (info.kind === "direct") return true
  // mode === 'normal' — apply the time-bounded mute when active
  const now = Date.now()
  if (!filter.filter_until || filter.filter_until <= now) return true
  const muted = filter.filter_mute ? safeJsonArray(filter.filter_mute) : null
  if (!muted || muted.length === 0) return false // mute covers all topics
  const topic = info.topic
  if (!topic) return true
  return !muted.some((g) => globMatch(g, topic))
}

function safeJsonArray(s: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(s)
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) return parsed as string[]
    return null
  } catch {
    // silent-fallback-allow: malformed mute topic JSON disables the optional topic-specific mute list.
    return null
  }
}

/** Minimal glob: '*' matches anything within a kind segment. */
function globMatch(pattern: string, value: string): boolean {
  if (pattern === "*") return true
  if (!pattern.includes("*")) return pattern === value
  const re = new RegExp("^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$")
  return re.test(value)
}

// ---------------------------------------------------------------------------
// Broadcast capability surface
// ---------------------------------------------------------------------------

export interface Broadcast {
  /** Push a single event to one client (helper for replay/bootstrap). */
  pushToClient(connId: string, method: string, params?: Record<string, unknown>): void
  /** Persist `sessions.last_delivered_{ts,seq}` for a recipient. Idempotent. */
  persistDeliveredCursor(sessionId: string, ts: number, seq: number): void
  /** Synchronous fanout — invoked by the messageTap on every message insert. */
  toConnected(info: MessageInsertedInfo): Promise<void>
  /** Explicit daemon health diagnostic → bounded ambient durable row. */
  log(msg: string, type: string): void
  /** Flush + discard a connection's coalescer state on disconnect. */
  flushConnection(connId: string): void
  discardConnection(connId: string): void
  /** The message tap used on daemonCtx — assign to per-client ctx in dispatcher. */
  messageTap: (info: MessageInsertedInfo) => void
}

export interface WithBroadcast {
  readonly broadcast: Broadcast
}

/**
 * withBroadcast — install the broadcast capability on the daemon value and
 * route the daemon's own ctx.onMessageInserted through the activity-log +
 * fanout tap. Must come AFTER withClientRegistry, withDatabase, and
 * withDaemonContext in the pipe.
 */
export function withBroadcast<T extends BaseTribe & WithDatabase & WithDaemonContext & WithClientRegistry>(): (
  t: T,
) => T & WithBroadcast {
  return (t) => {
    const { db, stmts, daemonCtx, registry } = t
    const { clients } = registry

    function canFanout(connId: string): boolean {
      const client = clients.get(connId)
      return Boolean(
        client &&
        !client.socket.destroyed &&
        client.socket.writable &&
        (client.role === "watch" || registry.isPushTransport(connId)),
      )
    }

    function pushToClient(connId: string, method: string, params?: Record<string, unknown>): void {
      const client = clients.get(connId)
      if (!client || !canFanout(connId)) return
      try {
        client.socket.write(makeNotification(method, params))
      } catch {
        /* dead */
      }
    }

    function persistDeliveredCursor(sessionId: string, ts: number, seq: number): void {
      try {
        stmts.updateLastDelivered.run({ $id: sessionId, $ts: ts, $seq: seq })
      } catch {
        /* best effort — session row may not exist yet (daemon-self, watch-*) */
      }
    }

    const coalescer = createCoalescer({
      batchMs: broadcastBatchMs(),
      maxEventsPerBatch: 50,
      deps: {
        singleEvent: singleEventNotification,
        batched: batchedNotification,
        write(connId, payload) {
          const client = clients.get(connId)
          // #38676: a client that is gone or not our push transport cannot take the wake; say so, so the coalescer
          // keeps the event and retries instead of discarding it.
          if (!client || !canFanout(connId)) return false
          try {
            // #38676: `socket.write` answers false under BACKPRESSURE, where the bytes are queued and will flush, so
            // reporting it as a failure would leave a healthy seat's cursor behind. Only a dead socket is a failure.
            client.socket.write(payload)
            return !client.socket.destroyed
          } catch {
            return false
          }
        },
        onWriteFailed(connId, events, attempt) {
          // #38676: ONE line per failure burst, naming the session and the rows it could not write, then a slow beat so a
          // genuinely wedged transport keeps saying so without flooding the journal (NO SILENT ERRORS, no noise).
          if (attempt !== 1 && attempt % 30 !== 0) return
          const client = clients.get(connId)
          const sessionId = client?.ctx.sessionId ?? connId
          const rowids = events.map((ev) => ev.rowid).join(",")
          const said = `fanout: could not write ${events.length} wake(s) to ${sessionId} (rows ${rowids}) on attempt ${attempt}; they are kept and retried`
          try {
            process.stderr.write(`tribe-daemon: ${said}\n`)
          } catch {
            // silent-fallback-allow: the line above is the report, and stderr is the channel it was written to; when
            // that channel itself is gone there is nothing left to say it on, and the kept rows and the retry stand.
          }
          try {
            broadcast.log(said, "warn")
          } catch {
            // silent-fallback-allow: stderr already carried this same sentence one line above; the durable copy is a
            // nicety, while the retry that keeps the wake is not, so a journal that cannot take it changes nothing.
          }
        },
        onDelivered(connId, ev) {
          const client = clients.get(connId)
          if (!client) return
          persistDeliveredCursor(client.ctx.sessionId, ev.ts, ev.rowid)
        },
      },
    })

    async function toConnected(info: MessageInsertedInfo): Promise<void> {
      // Journal-only rows (kind='event') stay durable but are never delivered.
      if (info.kind === "event") return
      // 'pull' rows are inbox-only — durable but not fanned out.
      if (info.delivery === "pull") return

      // Neutralize transcript-shaped triggers. Skip Haiku entirely if the
      // original content has no trigger patterns AND the regex scrub was a
      // no-op — short structured messages don't need paraphrasing.
      const hadTrigger = hasInjectionTrigger(info.content)
      let cleaned = scrubInjectionShape(info.content)
      if (hadTrigger || cleaned !== info.content) {
        cleaned = await rewriteViaHaiku(cleaned)
      }

      // Derive the channel-envelope reply hint from durable metadata
      // (km-tribe.filter-collapse: the response_expected column was dropped).
      // Used only by the `focus` mode of tribe.filter — the wire envelope no
      // longer carries the hint.
      const replyHint = deriveReplyHint({
        kind: info.kind,
        recipient: info.recipient,
        senderRole: info.senderRole,
      })

      const pending: PendingBroadcast = {
        id: info.id,
        ts: info.ts,
        rowid: info.rowid,
        type: info.type,
        sender: info.sender,
        content: cleaned,
        bead_id: info.bead_id,
        replyHint,
        topic: info.topic,
      }

      for (const [connId, client] of clients) {
        // Don't echo a message back to its own sender.
        if (client.name === info.sender) continue
        const isWatch = client.role === "watch"
        if (!isWatch) {
          if (info.recipient !== "*" && info.recipient !== client.name) continue
        }
        if (client.role === "pending") continue

        // km-bearly.tribe-dm-delivery-gap: pull-mode recipients drain via
        // tribe.fetch. Skip socket fanout — the message row is
        // already durable in SQLite from the sendMessage tap. `watch` clients
        // (TUI dashboards) always get push regardless of recipient mode so the
        // live view stays current.
        if (!canFanout(connId)) continue

        // km-tribe.filter-collapse: per-session unified filter. Direct messages
        // bypass normal mute/until; opted-in focus seats keep actionable DMs
        // while notification-only topics remain durable pull history.
        if (!isWatch) {
          const sessionFilter = stmts.getSessionFilter.get({ $id: client.ctx.sessionId }) as SessionFilter | undefined
          const settlesOwnRequest = settlesRequestOpenedBy(info, client.name)
          if (
            !shouldDeliver(
              {
                kind: info.kind,
                type: info.type,
                replyHint,
                topic: info.topic,
                settlesOwnRequest,
                isIncident: info.isIncident,
                wakesOwner: info.wakesOwner,
                attentionRequired: info.attentionRequired,
              },
              sessionFilter,
            )
          ) {
            continue
          }
        }

        // Direct messages bypass coalescing — they're time-sensitive.
        if (info.kind === "direct") {
          try {
            client.socket.write(singleEventNotification(pending))
            persistDeliveredCursor(client.ctx.sessionId, info.ts, info.rowid)
          } catch {
            /* dead */
          }
          continue
        }

        coalescer.enqueue(connId, pending)
      }
    }

    const persistHealthLog = (msg: string, type: string): void => {
      sendMessage(daemonCtx, "*", msg, type, undefined, undefined, "broadcast", {
        delivery: "pull",
        topic: type,
      })
    }
    const healthLogAdmission = createHealthLogAdmission(persistHealthLog)
    const broadcastLogFn = (msg: string, type: string): void => healthLogAdmission.accept(msg, type)

    // Install the activity-log + fanout tap on the daemon's ctx so logActivity()
    // and the health-monitor / plugin writers all flow through it.
    const messageTap = (info: MessageInsertedInfo): void => {
      writeActivity(activityFromMessage(info))
      // Fire-and-forget: toConnected is async (Haiku rewrite path is awaited
      // inside). Swallow rejections so a flaky LLM can't kill the tap.
      void toConnected(info).catch(() => {})
    }
    daemonCtx.onMessageInserted = messageTap

    t.scope.defer(() => {
      healthLogAdmission.flush()
      daemonCtx.onMessageInserted = undefined
    })

    log.info?.("broadcast pipeline ready (coalescer + scrubber + bounded health admission)")

    // #38676 residual: a wake inserted while this seat had no push transport is durable but was never
    // fanned out — `toConnected` walks connected clients, so an absent transport means nothing is
    // queued and nothing retries. One wakeup on attach is enough: a wakeup's only job is to tell the
    // client to fetch `latest_seq`, and advancing the cursor to the newest undelivered row retires the
    // older ones exactly as a batched fanout does.
    const pushConnFor = (sessionId: string) => {
      for (const [connId, client] of clients) {
        if (client.ctx.sessionId === sessionId && registry.isPushTransport(connId)) return { connId, client }
      }
      return undefined
    }

    const catchUpOnAttach = (sessionId: string): void => {
      const target = pushConnFor(sessionId)
      if (target === undefined) return
      const reading = readCatchUp(db, sessionId, target.client.name)
      const newest = reading.newest
      if (newest === null) return
      const sessionFilter = stmts.getSessionFilter.get({ $id: sessionId }) as SessionFilter | undefined
      const wakes =
        reading.anyActionable ||
        shouldDeliver(
          {
            kind: newest.kind,
            type: newest.type,
            replyHint: "optional",
            topic: newest.topic,
            settlesOwnRequest: newest.settlesOwnRequest,
            isIncident: newest.isIncident,
            wakesOwner: newest.wakesOwner,
            attentionRequired: newest.attentionRequired,
          },
          sessionFilter,
        )
      if (!wakes) return
      const event: PendingBroadcast = {
        id: newest.id,
        ts: newest.ts,
        rowid: newest.rowid,
        type: newest.type,
        sender: newest.sender,
        content: "",
        bead_id: null,
        replyHint: "optional",
        topic: newest.topic,
      }
      if (newest.kind === "direct") {
        // Direct rows never batch (broadcast-coalescer.ts), so they take the path the tap gives them.
        try {
          target.client.socket.write(singleEventNotification(event))
          persistDeliveredCursor(sessionId, newest.ts, newest.rowid)
        } catch {
          // The attach's own socket died between registration and this microtask. The row stays
          // undelivered and the next attach tries again; say so rather than swallow it.
          log.warn?.(
            `catch-up on attach for ${target.client.name}: the direct write failed; rowid ${newest.rowid} stays undelivered`,
          )
          return
        }
      } else {
        coalescer.enqueue(target.connId, event)
      }
      log.info?.(
        `catch-up on attach for ${target.client.name}: one wakeup for ${reading.rows} row(s) never fanned out, ` +
          `newest rowid ${newest.rowid} (${newest.type} from ${newest.sender})`,
      )
    }

    const pushStateBySession = new Map<string, boolean>()
    const stopCatchUp = registry.onTransportsChanged((sessionId) => {
      const pushing = pushConnFor(sessionId) !== undefined
      const was = pushStateBySession.get(sessionId) ?? false
      pushStateBySession.set(sessionId, pushing)
      if (!pushing || was) return
      // Outside the registry's own callback: registration is still unwinding, and a write must not run
      // inside it.
      queueMicrotask(() => catchUpOnAttach(sessionId))
    })
    t.scope.defer(stopCatchUp)

    const broadcast: Broadcast = {
      pushToClient,
      persistDeliveredCursor,
      toConnected,
      log: broadcastLogFn,
      flushConnection: (connId) => coalescer.flush(connId),
      discardConnection: (connId) => coalescer.discard(connId),
      messageTap,
    }

    return { ...t, broadcast }
  }
}

// Re-export so callers (tests, surface adapters) can import the message-shape
// helpers directly without reaching into the scrubber module.
export { hasInjectionTrigger, scrubInjectionShape } from "../broadcast-scrubber.ts"
