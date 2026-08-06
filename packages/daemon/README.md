# tribe-daemon

Broker daemon for Tribe.

`tribe-daemon` owns the long-running process that hosts a tribe: Unix socket
server, SQLite state, session registry, message journal, delivery modes, and
daemon plugins.

The in-memory authenticated session registry is the transport-liveness
authority. `tribe.members({ all: true })` joins that registry to durable session
rows and reports `transport_state` separately from `owner_state`; database
timestamps are activity evidence and never determine whether push delivery is
connected. A stored numeric PID is not process identity after disconnect, so
unbound owners report `unknown`. Complete launch identity declares a durable
registration; absent launch identity declares connection-scoped lifetime.
After the bounded reconnect grace, the daemon automatically reaps disconnected
connection-scoped rows on its existing cleanup cadence. The same classifier is
available through `tribe repair --reap-stale-transports`; it never signals a
process, restarts the daemon, or deletes messages/pending balls.

## Status

Functional; ships with this repository (not published to npm). Run it through
an explicit lifecycle owner such as Hab, an installed hook, or a direct clone.
Provider-owned MCP bridges only connect to it.

## Run

```bash
bun packages/daemon/src/daemon.ts                                    # auto-discovers socket path
bun packages/daemon/src/daemon.ts --socket ~/.local/share/tribe/tribe.sock
```

Provider bridges do not autostart this daemon. Explicit hook/install lifecycle
paths may detach the repo-local standalone supervisor, which owns the daemon as
its child; Hab supplies the owner in managed deployments. A missing daemon
stays visible and actionable to callers.
Lifecycle details: [docs/daemon.md](../../docs/daemon.md).

## Boundary

This package is reusable infrastructure. It should not encode project-specific
workflow concepts such as coordinator roles, worker numbering, task queues,
branch assignments, or merge authority.

## Pending-ball deadline facts

Direct `request`, `query`, and `assign` messages open one recipient-owned ball;
other message types open one only when explicitly requested. The
`pending_request` row stores active ownership, age, and fanout. Tracked requests
and queries receive a 20-minute escalation deadline; assignments have no
reply-clock default. `expires_in_ms` overrides that policy for one send.
Deadline passage changes presentation, never membership: the owner keeps the
row, which reads `expired`, sorts first, and carries its age. Reads compare the
deadline directly and are authoritative even when the idempotent
`ball.expired` journal echo has not reached its next recorder sweep. The
expired/unanswered view derives from the active row, hot and archived deadline
and settlement facts, and durable replies rather than retaining a second status
table. Non-reply settlement reasons remain distinct: `manual-close`,
`incident-cleared`, `gc-expired`, and `sender-withdrawn`; answers derive from
reply messages.
Reminders, pages, transfer, and escalation remain consuming L3 controller
policy.
