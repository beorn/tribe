# Claude Code Plugin (tribe@tribe)

The Claude Code host integration for tribe. Installed from this repository's
marketplace (`.claude-plugin/marketplace.json` at the repo root):

```text
/plugin marketplace add beorn/tribe
/plugin install tribe@tribe
```

This plugin is intentionally thin. It wires Claude Code to `tribe-wire`'s MCP
stdio adapter, which connects to the in-repo `tribe-daemon` without taking over
its lifecycle. The `recall/` subdirectory holds the lore primitives the
daemon's memory surface calls back into (socket, RPC, config, summarizer).

## Components

| Component     | Package          | Owns                                                                    |
| ------------- | ---------------- | ----------------------------------------------------------------------- |
| Wire client   | `tribe-wire`     | Protocol client, `tribe-wire` CLI, and `tribe-wire mcp` adapter         |
| Daemon        | `tribe-daemon`   | Broker process, SQLite state, sessions, message journal, daemon plugins |
| Claude plugin | `plugins/claude` | Claude Code MCP registration and connect-only bridge supervision        |

Project workflow conventions such as coordinator roles, worker numbering, task queues, branch assignments,
and integration authority are outside this package. Those belong to the
consumer's tent/SOP layer.

## Direct MCP config (no plugin channels)

For a local project-level MCP config without plugin channels:

```json
{
  "mcpServers": {
    "tribe": {
      "command": "bunx",
      "args": ["tribe-wire", "mcp"]
    }
  }
}
```

Both routes expect an existing or forwarded daemon socket.

## Daemon-restart recovery

The plugin entry point is a stable stdio supervisor. Its adapter child connects
to the daemon socket and asks the supervisor for a current-disk replacement
when it observes a new daemon generation, exhausts bounded reconnect, or
remains reconnecting for 60 seconds while a fresh daemon RPC succeeds. Source
changes and daemon reload notifications use that same wrapper-owned replacement
path;
adapters never spawn adapters. The wrapper—and therefore Claude Code's stdio
channel—stays in place while the child changes.

Updating the plugin on disk does not rewrite code already evaluated inside a
running pre-supervisor process. Such sessions still require `/mcp` reconnect or
a host-session restart once; newly launched/current-code plugin processes then
self-heal through the supervisor.

## Boundary

Reusable protocol code belongs in `tribe-wire`; broker code belongs in
`tribe-daemon`; host setup belongs here. Keep project-specific team workflow
out of this plugin.
