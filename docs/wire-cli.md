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
`tribe.members` returns over MCP, including `launch_id`, `transport_state`, and
`owner_state` per row. A disconnected row without process-identity binding
reports owner `unknown`; bare numeric PID existence is never proof that the
original registrant is alive. This is the row-level counterpart to the
human-formatted `sessions` table.

### `pending`

```bash
tribe-wire pending [--all] [--json] [--expired] [-o, --owner <name>] [-s, --stale <15m|1h|...>] [--close <request_id>]
```

Ball-tracker query: open requests where `owner` (default: caller's session)
is responsible for replying. `--all` lists every owner's open requests,
grouped (mutually exclusive with `--owner`). `--expired` is a read-only,
derive-at-read expired/unanswered view. A live deadline-passed row remains
owned and reports `status: "expired"`, `settlement: null`; historical non-reply
outcomes report `status: "unanswered"` plus `manual-close`,
`incident-cleared`, `gc-expired`, or `sender-withdrawn`. A later reply is the
authoritative `answered` fact and removes that row from this view. Requests and
queries default to a 20-minute escalation deadline; assignments have no
reply-clock default. `--expires-in-ms` overrides the policy for one send.
`--close <id>` records a typed non-reply settlement and closes one pending
request without sending a reply — requires `--owner`. Example:

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

Diagnostics: issues list, a live roster table (from the dispatcher's in-memory
client map, not the DB), durable-launch rows missing transport, and daemon
pid/uptime/clients. Disconnected connection-scoped legacy rows are repairable
litter, not process-live wedges. No options.

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

Long-polls the actionable inbox. A fresh logical wait returns immediately when
a request/query/assign/verdict direct is still unacknowledged, then later
chunks wake only for qualifying rows beyond that logical wait's durable
baseline. Internally the CLI chunks the wait
(30s per RPC call by default) and transparently retries across transient
daemon disconnects/unavailability within the overall timeout, so a single
logical wait survives a daemon hot-reload mid-poll. The logical window caps at
30 minutes; every result reports the applied value as `effective_timeout_ms`.
The `status` discriminant is `woken`, `timeout`, or `aborted`; the legacy
boolean flags remain for compatibility. `timeout` means the full logical
deadline elapsed with no qualifying current or later inbox row; the returned
attention snapshot may still carry quiet responses or pending balls. Before waiting,
the CLI verifies the daemon's protocol version. A stale daemon is refused with
the client/daemon version plus its running, on-disk, and superproject pins
instead of attempting to parse a stale reply shape.

An `aborted` daemon result is terminal and the CLI returns it without retrying.
It is observable only when the daemon can send that result over a still-open
socket. Closing the waiting client's own socket both causes cancellation and
destroys the reply path, so the public CLI can observe only the transport
close—not the resulting daemon-side `aborted` value. A future externally
observable cancellation contract therefore needs a separate control path or a
reply channel that survives cancellation; it cannot be created in the current
client wrapper.
By default only actionable messages wake the wait. Opt into a validated
`response` or `status` for one of the waiting session's own tracked requests
with `--wake-on-correlated-reply`.

### `repair`

```bash
tribe-wire repair [--session <name>=@chief] [--inbox-cursor tail | --reap-stale-transports] [--json]
```

Operator-bounded state repair. With no mode flag, the CLI retains the existing
`--inbox-cursor tail` default. `--reap-stale-transports` instead removes only
disconnected registrations whose absent launch identity declares
connection-scoped lifetime and whose reconnect grace has elapsed. Active
sibling transports, complete launch identities, malformed partial provenance,
messages, and pending balls are preserved. The JSON result reports examined and
reaped totals, reason counts, and reaped member ids/names. The modes are
mutually exclusive; neither repair signals a process or restarts the daemon.

### `restart`

```bash
tribe-wire restart [--reason <text>] [--json]
```

Restarts the **daemon** via the `tribe.restart` RPC. The daemon re-execs from
the same pinned module root, so this changes no code; connected clients
reconnect on their own. `--reason` is logged by the daemon. Use a separate
materialize/activate operation to change the code root.

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
tribe-wire send <to> <message...> [-t, --type <type>] [-s, --summary <text>] [--delivery push|pull] [--ref <text>] [--reply <request_id>] [--anonymous] [--request [request_id]] [--fanout first|all] [--expires-in-ms <ms>]
```

`<to>` is a session name or `*` for broadcast. `--type` is one of `assign`,
`status`, `query`, `response`, `notify` (default), `request`, `verdict` —
the daemon delivers every type to every session; no type is role-gated.
`--reply <request_id>` closes a tracked request. At registration, managed
adapters derive a seat launch id from the provider launch plus persona with
`deriveTribePersonaLaunchIdentity`; two personas from one provider launch
therefore have distinct routable and writer identities. A managed one-shot CLI
still presents the provider-owned `TRIBE_LAUNCH_ID`. The daemon resolves its
derived identity family and uses `TRIBE_NAME`/`TRIBE_SESSION_NAME` only to
narrow within that family; a stale or hostile name cannot select another
provider launch. The CLI then attaches its one-shot connection to the resolved
live member so the message is attributed. A name without launch authority is
never accepted as ordinary-send attribution.
An unattributable send fails instead of silently delivering from a generated
pending identity. `--anonymous` is the explicit exception and is limited to
untracked messages: it cannot be combined with reply/request/incident tracking
or with `request`, `query`, or `assign` types. For replies, an unmanaged CLI
uses `TRIBE_NAME`/`TRIBE_SESSION_NAME` only for the ownership preflight. The
command verifies ownership against
`tribe.pending` before sending, and verifies the daemon's committed-closed count
afterward; it will not report success on an unproven close.
If the first non-whitespace message token looks like `reply=<id>` or
`ref=<value>`, `send` always exits 2 before daemon I/O—even when a matching or
different structured flag is also present—and prints the exact `--reply <id>`
or `--ref <value>` replacement. Remove the marker from content; message prose
never mutates reply/ref state.
`--request` and `--request true` opt any direct message into ball-tracking with
the message's unique id (direct request/query/assign auto-track already).
`--delivery pull` pins the send to the named recognized mailbox: a disconnected
transport or disconnected configured fallback does not refuse it. Recognition
comes from a complete managed launch record or journal activity inside the
existing four-hour activity horizon; a never-seen name still fails loudly and
opens no ball.
Another non-empty value overrides the id or opts in a
`notify`/`response`/`verdict`; the explicit id `true` is reserved and rejected
by the daemon. `--fanout all` opens one ball per recipient on a multi-target
send instead of the default first-reply-wins.
`--expires-in-ms` sets an escalation deadline for that send. Requests and
queries otherwise default to 20 minutes; assignments have no reply-clock
default. Passing the deadline makes the obligation louder and records a durable
observation, but never closes it.

```bash
tribe-wire send '@alice' 'task X done' --type=notify --anonymous
tribe-wire send '@ci' 'R656 failed; see journal evidence' --type=notify --delivery=pull --anonymous
```

### `join`

```bash
tribe-wire join <name> [-r, --role <role>=member] [-d, --domain <label>] [--delivery pull|push=pull] [--json]
```

One-shot join/rejoin checkpoint — verifies an already-persistent native
session without registering, renaming, or disconnecting a member. It exits
nonzero when no live persistent holder owns `<name>`; the one-shot CLI cannot
establish durable membership itself. `--domain` remains repeatable or
comma-separated for command compatibility, but the checkpoint reports the
holder's actual role, domains, and delivery mode without mutating them.

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

The Markdown projection is a bounded human page: durable session identities,
per-seat ball arrivals/answers and p50/p90/max latency, typed endings, oldest
open age, and at most ten recent timeline entries. Unknown transport endpoints
are kept as one unattributed aggregate rather than counted as members. JSON is
the lossless analysis surface and also carries the correlated request/reply
corpus used by the supervised daily classification review. Historical endings
without durable outcome evidence remain `unknown`; they are never backfilled.

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
