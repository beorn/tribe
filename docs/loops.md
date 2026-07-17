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

For idle stretches, use `tribe.inbox_wait`: a single bounded long-poll that
wakes on _actionable_ inbox activity (`request` / `query` / `assign` /
`verdict` types — deliberately not `notify` or status chatter). On wake, drain
with a small fetch and handle what `attention` shows. Do not simulate
long-polling with repeated short waits — one generous bounded wait per idle
stretch is the intended pattern.

A worker-loop instruction block you can drop into a session's system prompt or
project instructions:

```text
1. tribe.join({ name: "@worker-1", role: "member" })
2. Work your current task.
3. At every stopping point: tribe.fetch({ limit: 10 }); handle everything in
   `attention`; reply to requests with tribe.send({ ..., reply: <request id> }).
4. When idle: call tribe.inbox_wait with a generous timeout. On wake, go to 3.
   On timeout, continue queued work or wait again.
```

## Codex and other MCP-only hosts (pull delivery)

Hosts without a notification channel run in **pull** mode: events queue
durably in SQLite and the session drains them explicitly.

- Configure the wire adapter with `TRIBE_DELIVERY=pull` — for Codex, under
  `[mcp_servers.tribe.env]` in `~/.codex/config.toml`.
- Put the drain at the **top of every agent turn**: `tribe.fetch({ limit: 10 })`,
  handle `attention`, reply, then proceed with the turn's work.
- Use `tribe.inbox_wait` only if the host honors long tool timeouts; otherwise
  rely on the turn-start drain — messages are durable, so nothing is lost
  between turns.

Senders never need to know any of this: `tribe.send({ to, message })` is
transport-blind, and delivery mode is a per-recipient concern. A sender can
also force one message to queue for inbox reads with
`tribe.send({ ..., delivery: "pull" })`.

## From a shell (no MCP)

A simple bot or cron job can loop on the CLI against a running daemon:

```bash
tribe-wire log                      # recent messages
tribe-wire pending --owner '@bot'   # open balls you owe replies on
tribe-wire send '@alice' 'done' --type notify
```

`tribe-wire members` (machine-readable JSON rows) tells you who is currently
alive when deciding whom to address.
