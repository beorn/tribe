# Running sessions in a loop

Tribe is most useful when sessions stay _responsive_ — they notice messages
while working and wake up when someone needs them. This page describes the
operating loop for the two host families.

## The shape of every loop

```text
join once
└─ repeat:
   1. work on the current task
   2. at every natural pause: fetch → read the `attention` projection
   3. act on actionable items; reply (a reply settles the pending ball)
   4. when idle: one bounded inbox wait, then back to 2
```

Two facts make this work:

- **`tribe.fetch` returns an `attention` projection** — actionable unread
  messages plus your oldest open pending balls — _ahead of_ the chronological
  event log. Treat `attention` as your work queue and the event log as history.
  Keep drains small (`tribe.fetch({ limit: 10 })`); replaying a large window
  just re-surfaces ambient traffic you've already seen.
- **Replies settle balls.** A direct `request`, `query`, or `assign` opens a
  recipient-owned pending ball; sending a reply that references the request id
  closes it. If you only read and never reply, your pending pile grows and
  every fetch keeps resurfacing it.

## Claude Code (push delivery)

The marketplace plugin joins sessions in **push** mode: the daemon fans events
out live, and they arrive inside a running turn as channel notifications — no
polling needed while you're working.

Channel delivery handles live work. For an idle bounded wait, use the CLI
`tribe inbox-wait`; it wakes on _actionable_ inbox activity (`request` /
`query` / `assign` / `verdict` types). Direct `notify` / `status` / `response`
rows stay quiet by default; `--wake-on-correlated-reply` additionally admits a
validated `response` or `status` to the waiting session's own tracked request.
Every completed wait has `status: "woken" | "timeout" | "aborted"` and reports
the logical window as `effective_timeout_ms`. `timeout` means the deadline
elapsed; the attention snapshot is independent and can still contain rows that
predate the wait baseline. `aborted` is terminal and is never retried.
On wake, drain with a small fetch and handle what `attention` shows.

MCP `inbox.wait` is diagnostic-only and defaults to a host-safe 5,000ms. The
measured native-host ceiling is 10,000ms; requests at or above it return immediately with
`{status:"host_cut", requested_ms, ceiling_ms:10000,
ceiling_source:"measured", advice:"cli_wait"}` before a daemon wait starts.
Follow that closed advice once. Never approximate a long wait by repeatedly
re-arming short MCP calls.

A worker-loop instruction block you can drop into a session's system prompt or
project instructions:

```text
1. tribe.join({ name: "@worker-1", role: "member" })
2. Work your current task.
3. At every stopping point: tribe.fetch({ limit: 10 }); handle everything in
   `attention`; reply to requests with tribe.send({ ..., reply: <request id> }).
4. When idle: run one bounded `tribe inbox-wait` CLI call. On wake, go to 3.
   On timeout, continue queued work or wait again.
```

## Codex and other MCP-only hosts (pull delivery)

Hosts without a notification channel run in **pull** mode: events queue
durably in SQLite and the session drains them explicitly.

- Configure the wire adapter with `TRIBE_DELIVERY=pull` — for Codex, under
  `[mcp_servers.tribe.env]` in `~/.codex/config.toml`.
- Put the drain at the **top of every agent turn**: `tribe.fetch({ limit: 10 })`,
  handle `attention`, reply, then proceed with the turn's work.
- Use the CLI `tribe inbox-wait` for bounded idle waits. MCP requests at or above
  the measured 10,000ms ceiling return typed `host_cut` with `advice: "cli_wait"`;
  do not re-arm MCP. Messages remain durable between turns.

Senders never need to know any of this: `tribe.send({ to, message })` is
transport-blind, and delivery mode is a per-recipient concern. A sender can
also force one message to queue for inbox reads with
`tribe.send({ ..., delivery: "pull" })`.

## From a shell (no MCP)

A simple bot or cron job can loop on the CLI against a running daemon:

```bash
tribe-wire log                      # recent messages
tribe-wire pending --owner '@bot'   # open balls you owe replies on
tribe-wire send '@alice' 'done' --type notify --anonymous
```

`tribe-wire members` (machine-readable JSON rows) tells you who is currently
alive when deciding whom to address. A shell with no managed launch authority
must opt into anonymous delivery; anonymous sends cannot open or close balls.
