# @beorn/tribe

Claude Code integration for Tribe.

This plugin is intentionally thin. It wires Claude Code to `tribe-wire`'s MCP
stdio adapter and points that adapter at `tribe-daemon` when the host owns
daemon lifecycle.

## Components

| Component | Package | Owns |
| --- | --- | --- |
| Wire client | `tribe-wire` | Protocol client, `tribe` CLI, and `tribe mcp` adapter |
| Daemon | `tribe-daemon` | Broker process, SQLite state, sessions, message journal, daemon plugins |
| Claude plugin | `@beorn/tribe` | Claude Code MCP registration and daemon-script wiring |

Project workflow conventions such as `@chief`, `@agent/N`, beads, worktrees,
and integration authority are outside this package. Those belong to the
consumer's tent/SOP layer.

## Install

```bash
claude plugin marketplace add beorn/tribe
claude plugin install tribe@beorn
```

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
