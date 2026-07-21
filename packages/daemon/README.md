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

Functional; ships with this repository (not published to npm). The Claude Code
plugin autostarts it, or run it directly from a clone.

## Run

```bash
bun packages/daemon/src/daemon.ts                                    # auto-discovers socket path
bun packages/daemon/src/daemon.ts --socket ~/.local/share/tribe/tribe.sock
```

Host plugins may autostart this daemon for their runtime. The wire package does
not silently own daemon lifecycle; a missing daemon should be visible and
actionable to callers. Lifecycle details: [docs/daemon.md](../../docs/daemon.md).

## Boundary

This package is reusable infrastructure. It should not encode project-specific
workflow concepts such as coordinator roles, worker numbering, task queues,
branch assignments, or merge authority.

## Pending-ball deadline facts

Direct `request`, `query`, and `assign` messages open one recipient-owned ball;
other message types open one only when explicitly requested. The
`pending_request` row stores ownership, age, fanout, and an optional
sender-declared deadline. Tribe supplies those facts without a default and does
not interpret a passed deadline as a reminder, page, transfer, or settlement;
replies still close the original ownership row. Habitat policy and actuation
belong to the consuming L3 controller.
