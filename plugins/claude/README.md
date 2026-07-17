# Claude Code Plugin (tribe@tribe)

The Claude Code host integration for tribe. Installed from this repository's
marketplace (`.claude-plugin/marketplace.json` at the repo root):

```text
/plugin marketplace add beorn/tribe
/plugin install tribe@tribe
```

This plugin is intentionally thin. It wires Claude Code to `tribe-wire`'s MCP
stdio adapter and points that adapter at the in-repo `tribe-daemon`, which the
host autostarts on first use. The `recall/` subdirectory holds the lore
primitives the daemon's memory surface calls back into (socket, RPC, config,
summarizer).

## Components

| Component     | Package          | Owns                                                                    |
| ------------- | ---------------- | ----------------------------------------------------------------------- |
| Wire client   | `tribe-wire`     | Protocol client, `tribe-wire` CLI, and `tribe-wire mcp` adapter         |
| Daemon        | `tribe-daemon`   | Broker process, SQLite state, sessions, message journal, daemon plugins |
| Claude plugin | `plugins/claude` | Claude Code MCP registration and daemon-script wiring                   |

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

That direct `tribe-wire` route expects an existing or forwarded daemon socket.
The plugin route owns daemon-script wiring through `tribe-daemon`.

## Boundary

Reusable protocol code belongs in `tribe-wire`; broker code belongs in
`tribe-daemon`; host setup belongs here. Keep project-specific team workflow
out of this plugin.
