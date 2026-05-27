# Claude Plugin Placeholder

The published Claude Code plugin is `@bearly/tribe` and currently remains in
`github.com/beorn/bearly` during the cutover. This directory is a placeholder in
the standalone `beorn/tribe` repository so the split keeps the host-integration
boundary visible without creating or publishing an `@beorn` npm scope.

This plugin is intentionally thin. It wires Claude Code to `tribe-wire`'s MCP
stdio adapter and points that adapter at `tribe-daemon` when the host owns
daemon lifecycle.

## Components

| Component | Package | Owns |
| --- | --- | --- |
| Wire client | `tribe-wire` | Protocol client, `tribe-wire` CLI, and `tribe-wire mcp` adapter |
| Daemon | `tribe-daemon` | Broker process, SQLite state, sessions, message journal, daemon plugins |
| Claude plugin | `@bearly/tribe` | Claude Code MCP registration and daemon-script wiring |

Project workflow conventions such as `@chief`, `@agent/N`, beads, worktrees,
and integration authority are outside this package. Those belong to the
consumer's tent/SOP layer.

## Install

```bash
claude plugin install @bearly/tribe
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
