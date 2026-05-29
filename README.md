# Tribe

Reusable coordination infrastructure for coding-agent sessions.

Tribe lets multiple agent sessions discover each other, exchange messages, and
share project context through a local daemon. This repository owns the reusable
infrastructure only: wire protocol, daemon, and host integrations. Project
workflow conventions such as `@chief`, `@agent/N`, beads, worktrees, and
integration policy belong in a tent/SOP layer outside this repo.

## Components

| Component | Package | Binary | Owns |
| --- | --- | --- | --- |
| Wire client | `tribe-wire` | `tribe-wire` | Unix-socket client, reconnecting transport, MCP stdio adapter, protocol CLI |
| Daemon | `tribe-daemon` | `tribe-daemon` | Staged broker package; private until the bearly daemon/runtime cutover is complete |
| Claude Code plugin | `@bearly/tribe` | n/a | MCP registration and host-managed daemon lifecycle, still maintained from `github.com/beorn/bearly` during cutover |

## Mental Model

```text
Claude / Codex / Hermes
  -> tribe-wire mcp            # from package tribe-wire
  -> local or SSH-forwarded Unix socket
  -> tribe-daemon
  -> SQLite + daemon plugins
```

`tribe-wire` talks to an existing tribe. `tribe-daemon` is the staged home for
the broker process; the published daemon/plugin path still lives in bearly until
that cutover is complete. Host plugins wire those pieces into an agent runtime.

## Remote Agent Entry Point

Remote hosts should be able to run one of:

```bash
tribe-wire mcp --socket /tmp/tribe.sock
bunx tribe-wire mcp --socket /tmp/tribe.sock
npx -y tribe-wire mcp --socket /tmp/tribe.sock
```

The package name and binary name are both `tribe-wire` so package runners can
use the direct form without a package/binary split.

## Repository Layout

```text
packages/
  wire/      # npm tribe-wire; bin tribe-wire
  daemon/    # npm tribe-daemon; bin tribe-daemon
plugins/
  claude/    # placeholder; published Claude plugin remains @bearly/tribe
docs/
  architecture.md
```

## Status

This repository is being extracted from `github.com/beorn/bearly`.
`tribe-wire` is published and usable as the remote MCP adapter. `tribe-daemon`
and the Claude plugin are staged/private until daemon runtime dependencies and
host-plugin lifecycle are fully cut over. Destructive bearly cleanup happens
after package publishing, plugin install, and downstream consumers are verified.
