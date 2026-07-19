# `tribe-wire` CLI reference

This is a from-source reference for the `tribe-wire` binary — every verb
below is read directly out of `packages/wire/src/cli.ts`,
`packages/wire/src/cli/read.ts`, and `packages/wire/src/cli/send.ts` (not
from the package README, which undercounts the current verb list). All
verbs (except `mcp`) connect to the daemon over its Unix socket and, on
failure to connect, print:

```text
No daemon running (socket: <path>)
Start one with: bun tribe-daemon (package tribe-daemon), or let a host autostart it
```

Global: `tribe-wire --help` / `tribe-wire version` / `--version` / `-V` /
`-v` print `tribe-wire <version>+<sha>` and exit before any daemon connect.

## `mcp` — the MCP adapter

```bash
tribe-wire mcp [--name <name>] [--role <role>] [--socket <path>] ...
```

Not Commander-parsed — argv is forwarded as-is to the stdio adapter's own
parser (`parseTribeArgs`, `strict: false`), because it accepts flags
(`--account`, …) that Commander's strict mode would otherwise reject. This
is what a host's `.mcp.json` invokes; see [install.md](install.md).

## Read / inspect verbs

### `status`

```bash
tribe-wire status
```

Active sessions table (name, role, domains, uptime, source) plus daemon
pid/uptime/client count. No options.

### `sessions`

```bash
tribe-wire sessions [-a|--all]
```

Session table with PID, uptime, idle time, and a home-relative CWD column.
`--all` includes historical (disconnected) sessions; default is
daemon-live only.

### `members`

```bash
tribe-wire members [-a|--all]
```

Machine-readable JSON (`{"sessions": [...]}`) — the same reply
`tribe.members` returns over MCP, including `launch_id` and `alive` per row.
This is the row-level counterpart to the human-formatted `sessions` table.

### `pending`

```bash
tribe-wire pending [--all] [--json] [--expired] [-o, --owner <name>] [-s, --stale <15m|1h|...>] [--close <request_id>]
```

Ball-tracker query: open requests where `owner` (default: caller's session)
is responsible for replying. `--all` lists every owner's open requests,
grouped (mutually exclusive with `--owner`). `--expired` filters to rows
whose sender-declared deadline passed (read-only; not combinable with
`--close`). `--close <id>` closes one pending request without sending a
reply — requires `--owner`. Example:

```bash
tribe-wire pending --owner @alice --stale 15m
```

### `log`

```bash
tribe-wire log [-n, --limit <n>=20] [-a, --all] [-f, --follow] [--json] [--ref-prefix <p>] [--reply-prefix <p>]
```

Recent messages. `--follow` and `--json` are mutually exclusive with each
other and with `--all` (a follow is a live stream, not a bounded snapshot).
`--follow` subscribes to daemon notifications and also polls `cli_log` every
2s for new rows. Example: `tribe-wire log -n 50 --json`.

### `health`

```bash
tribe-wire health
```

Diagnostics: issues list (silent members, stale issue entries, etc.), a live
roster table (from the dispatcher's in-memory client map, not the DB), and
daemon pid/uptime/clients. No options.

### `doctor`

```bash
tribe-wire doctor [--fix]
```

Checks whether the **running** daemon's code is stale relative to on-disk
source / the superproject's pin (`tribe.health()`'s `code_pin` field). A
daemon too old to even report `code_pin` is treated as stale by construction
(absence of a known-current field is itself the staleness signal — a daemon
new enough to self-report would always have it). `--fix` prints the
operator remedy (update the pin, kill the stale pid, let autostart respawn)
— it never restarts anything itself.

### `inbox-status`

```bash
tribe-wire inbox-status [--session <name>] [--json]
```

Count + age of actionable DMs the target session hasn't drained yet. Without
`--session`, resolves the caller's own managed launch via `TRIBE_LAUNCH_ID`
(throws if that's unset and no `--session` was given).

### `inbox-drain`

```bash
tribe-wire inbox-drain [--session <name>] [--limit <n>=10] [--json]
```

Drains (returns + acknowledges) actionable DMs for a managed or explicit
mailbox, using the operator capability inherited via the
`TRIBE_OPERATOR_CAPABILITY_FD` file descriptor (never via env/argv — the
capability content never touches process-inspectable state).

### `inbox-wait`

```bash
tribe-wire inbox-wait [--session <name>] [--timeout <30s|1m|5m>=30s] [--wake-on-correlated-reply] [--json]
```

Long-polls the actionable inbox until a request/query/assign/verdict direct
message arrives or the timeout elapses. Internally chunks the wait
(30s per RPC call by default) and transparently retries across transient
daemon disconnects/unavailability within the overall timeout, so a single
logical wait survives a daemon hot-reload mid-poll. The logical window caps at
30 minutes; every result reports the applied value as `effective_timeout_ms`.
By default only actionable messages wake the wait. Opt into a validated
`response` or `status` for one of the waiting session's own tracked requests
with `--wake-on-correlated-reply`.

### `repair`

```bash
tribe-wire repair [--session <name>=@chief] [--inbox-cursor tail] [--json]
```

Operator-bounded state repair — currently the only supported repair is
advancing a session's inbox cursor to the current journal tail (no history
deleted).

### `reload`

```bash
tribe-wire reload [--reason <text>] [--json]
```

Hot-reloads the **daemon** via the `tribe.reload` RPC (SIGHUP-equivalent —
see [daemon.md](daemon.md) for what actually happens). `--reason` is logged
by the daemon.

### `activity`

```bash
tribe-wire activity [-f, --follow] [-s, --since <1h|30m|2d>] [--no-color]
```

Tails the unified activity log (tribe DMs + recall injections + gate
verdicts). Default window is "since today midnight"; `--follow` streams new
entries live.

### `reaper-exempt`

```bash
tribe-wire reaper-exempt [pid] [--clear] [--list] [--reason <text>]
```

Marks (or clears) a PID as exempt from the health-monitor's auto-kill —
for keeping a live repro process alive during debugging. `--list` shows all
current exemptions with their reasons.

## Send / messaging verbs

### `send`

```bash
tribe-wire send <to> <message...> [-t, --type <type>] [-s, --summary <text>] [--delivery push|pull] [--ref <text>] [--reply <request_id>] [--request [request_id]] [--fanout first|all] [--expires-in-ms <ms>]
```

`<to>` is a session name or `*` for broadcast. `--type` is one of `assign`,
`status`, `query`, `response`, `notify` (default), `request`, `verdict` —
the daemon delivers every type to every session; no type is role-gated.
`--reply <request_id>` closes a tracked request and requires
`TRIBE_NAME`/`TRIBE_SESSION_NAME` to be set (so the one-shot CLI caller can
be identified as the owner) — the command verifies ownership against
`tribe.pending` before sending, and verifies the daemon's committed-closed
count afterward; it will not report success on an unproven close.
`--request` opts any direct message into ball-tracking (direct
request/query/assign auto-track already; this overrides the id or opts in a
`notify`/`response`/`verdict`). `--fanout all` opens one ball per recipient
on a multi-target send instead of the default first-reply-wins.

```bash
tribe-wire send '@alice' 'task X done' --type=notify
tribe-wire send '@ci' 'R656 failed; see journal evidence' --type=notify --delivery=pull
```

### `join`

```bash
tribe-wire join <name> [-r, --role <role>=member] [-d, --domain <label>] [--delivery pull|push=pull] [--json]
```

One-shot CLI join/rejoin — registers an ephemeral connection, calls
`tribe.join`, then disconnects. `--domain` is repeatable or comma-separated
for multiple domain labels. Example: `tribe-wire join @scratch --domain
silvery,flexily`.

### `alarm`, `alarm-status`, `alarm-ack`

```bash
tribe-wire alarm <reason> [--by <name>]
tribe-wire alarm-status [--json]
tribe-wire alarm-ack
```

Andon-pull stop-the-line: `alarm <reason>` sets a project-wide flag a
consuming host's PreToolUse hook can block on; `alarm-status` reports the
active reason/age (or "no alarm active"); `alarm-ack` clears it. `--by`
defaults to `$USER`.

### `retro`

```bash
tribe-wire retro [-s, --since <2h|30m|1d>] [-f, --format markdown|json=markdown] [--db <path>]
```

Retrospective report (metrics, timeline, coordination health) generated by
reading the tribe DB **directly** (read-only `bun:sqlite`, `PRAGMA
busy_timeout = 5000`) rather than going through the daemon — this is the one
verb in this family that talks to the SQLite file instead of the socket.
`--db` overrides the same resolution order the daemon itself uses
(`--db` > `TRIBE_DB` > XDG default; see [daemon.md](daemon.md)).

## MCP tools with no CLI equivalent

Not every `tribe.*` MCP tool has a `tribe-wire` subcommand — some are
deliberately MCP-only (per `command-descriptors.ts`'s `hidden(...)`
projections), and a few have a same-named CLI command that is a **separate,
older implementation** rather than an exact projection of the MCP tool:

| MCP tool                                                                        | CLI status                                                                                                                                                                    |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fetch`                                                                         | No CLI. `log` is a related-but-different daemon-log view, not fetch parity (fetch is a live-session cursor/snapshot primitive).                                               |
| `members`                                                                       | Has a CLI (`members`, described above) — this one _is_ an exact JSON projection.                                                                                              |
| `rename`, `filter`, `debug`, `lifecycle`, `lifecycle.publish`, `health.publish` | MCP-only — no CLI projection exists in any form.                                                                                                                              |
| `health`, `reload`, `retro`                                                     | Have CLI commands, but the legacy CLI implementations (`cli_health`, SIGHUP-equivalent reload, direct-DB retro) predate and are not exact projections of the MCP descriptors. |

If you're scripting against tribe from a shell, the CLI covers coordination
and diagnostics well; if you're an agent with MCP tool access, the MCP
surface (via the Claude Code plugin or `tribe-wire mcp`) is a superset —
reach for `tribe.fetch`, `tribe.rename`, `tribe.filter` there instead of
looking for a CLI verb that doesn't exist.
