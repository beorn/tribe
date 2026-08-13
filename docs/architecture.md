# Tribe Architecture

Tribe has three reusable layers and one explicit non-goal.

## Layers

### Wire

`tribe-wire` is the client/protocol surface. It owns:

- JSON-RPC framing over Unix sockets
- reconnecting daemon clients
- MCP stdio adapter (`tribe-wire mcp`)
- protocol CLI verbs (`tribe-wire send`, `tribe-wire fetch`, `tribe-wire members`, etc.)
- MCP tool metadata

It does not own daemon lifecycle by default. If no daemon is reachable, wire
commands fail loudly and tell the caller how to start or install a daemon.

### Daemon

`tribe-daemon` is the broker. It owns:

- Unix socket server
- SQLite state and message journal
- session registry and delivery modes
- daemon plugin runtime
- Git/GitHub/health/issue-tracker-style event emitters where those are generic

Daemon runtime state is machine-local. The GitHub poller stores its cursor at
`$XDG_DATA_HOME/tribe/github-cursor.json` (falling back to
`$HOME/.local/share/tribe/github-cursor.json`), never in a project's `.beads/`
tree. On first start it adopts a legacy `.beads/github-cursor.json` under a
process-shared lock. Corrupt or conflicting source/destination state fails
loudly; identical dual state converges to the XDG-owned carrier.

### Host Plugins

Host plugins wire Tribe into an agent runtime. The Claude Code plugin owns MCP
registration and connect-only bridge supervision for that host. Explicit
lifecycle hooks live with the daemon install path. Other hosts can add their
own plugins without changing wire or daemon packages.

## Non-Goal: Team Workflow Policy

Project workflow is not reusable Tribe infrastructure. Concepts like named
coordinator roles, worker numbering, branch/worktree assignment, task queues,
and merge authority belong in the consuming project's own workflow layer.
Tribe transports messages; it does not
decide who is allowed to make a project-specific decision.

## Dependency Rule

```text
host plugin -> tribe-wire -> tribe-daemon protocol
daemon plugin -> tribe-wire primitives
project workflow layer -> tribe messages
```

Reusable packages must not import project-specific workflow code.
