# tribe-daemon

Broker daemon for Tribe.

`tribe-daemon` owns the long-running process that hosts a tribe: Unix socket
server, SQLite state, session registry, message journal, delivery modes, and
daemon plugins.

## Run

```bash
tribe-daemon --socket ~/.local/share/tribe/tribe.sock
```

Host plugins may autostart this daemon for their runtime. The wire package does
not silently own daemon lifecycle; a missing daemon should be visible and
actionable to callers.

## Boundary

This package is reusable infrastructure. It should not encode project-specific
workflow concepts such as `@chief`, `@agent/N`, bead queues, worktree slots, or
integration authority.
