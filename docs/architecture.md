# Tribe Architecture

Tribe has three reusable layers and one explicit non-goal.

## Layers

### Wire

`tribe-wire` is the client/protocol surface. It owns:

- JSON-RPC framing over Unix sockets
- reconnecting daemon clients
- MCP stdio adapter (`tribe mcp`)
- protocol CLI verbs (`tribe send`, `tribe fetch`, `tribe members`, etc.)
- MCP tool metadata

It does not own daemon lifecycle by default. If no daemon is reachable, wire
commands fail loudly and tell the caller how to start or install a daemon.

### Daemon

`tribe-daemon` is the broker. It owns:

- Unix socket server
- SQLite state and message journal
- session registry and delivery modes
- daemon plugin runtime
- Git/GitHub/health/beads-style event emitters where those are generic

### Host Plugins

Host plugins wire Tribe into an agent runtime. The Claude Code plugin owns MCP
registration and autostart hooks for that host. Other hosts can add their own
plugins without changing wire or daemon packages.

## Non-Goal: Tent Workflow

Project workflow is not reusable Tribe infrastructure. Concepts like `@chief`,
`@agent/N`, worktree slots, bead queues, and integration authority belong in a
tent/SOP layer in the consuming project. Tribe transports messages; it does not
decide who is allowed to make a project-specific decision.

## Dependency Rule

```text
host plugin -> tribe-wire -> tribe-daemon protocol
daemon plugin -> tribe-wire primitives
tent/SOP -> tribe messages
```

Reusable packages must not import project-specific tent/SOP code.
