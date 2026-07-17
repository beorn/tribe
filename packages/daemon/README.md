# tribe-daemon

Broker daemon for Tribe.

`tribe-daemon` owns the long-running process that hosts a tribe: Unix socket
server, SQLite state, session registry, message journal, delivery modes, and
daemon plugins.

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
workflow concepts such as `@chief`, `@agent/N`, bead queues, worktree slots, or
integration authority.

## Pending-ball deadline facts

Direct `request`, `query`, and `assign` messages open one recipient-owned ball;
other message types open one only when explicitly requested. The
`pending_request` row stores ownership, age, fanout, and an optional
sender-declared deadline. Tribe supplies those facts without a default and does
not interpret a passed deadline as a reminder, page, transfer, or settlement;
replies still close the original ownership row. Habitat policy and actuation
belong to the consuming L3 controller.
