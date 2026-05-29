# tribe-daemon

Broker daemon for Tribe.

`tribe-daemon` owns the long-running process that hosts a tribe: Unix socket
server, SQLite state, session registry, message journal, delivery modes, and
daemon plugins.

## Status

This package is staged and private during the bearly-to-tribe cutover. The
published daemon/plugin path still lives in `github.com/beorn/bearly`; this
package becomes runnable after the daemon runtime's recall/LLM dependencies are
extracted or replaced.

## Future Run

```bash
tribe-daemon --socket ~/.local/share/tribe/tribe.sock
```

After cutover, host plugins may autostart this daemon for their runtime. The
wire package does not silently own daemon lifecycle; a missing daemon should be
visible and actionable to callers.

## Boundary

This package is reusable infrastructure. It should not encode project-specific
workflow concepts such as `@chief`, `@agent/N`, bead queues, worktree slots, or
integration authority.
