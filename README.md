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
| Wire client | `tribe-wire` | `tribe` | Unix-socket client, reconnecting transport, MCP stdio adapter, protocol CLI |
| Daemon | `tribe-daemon` | `tribe-daemon` | Broker process, SQLite state, session registry, message journal, daemon plugin runtime |
| Claude Code plugin | `@bearly/tribe` | n/a | MCP registration and host-managed daemon lifecycle, still maintained from `github.com/beorn/bearly` during cutover |

## Mental Model

```text
Claude / Codex / Hermes
  -> tribe mcp                 # from package tribe-wire
  -> local or SSH-forwarded Unix socket
  -> tribe-daemon
  -> SQLite + daemon plugins
```

`tribe-wire` talks to an existing tribe. `tribe-daemon` runs one. Host plugins
wire those pieces into an agent runtime.

## Remote Agent Entry Point

Remote hosts should be able to run one of:

```bash
tribe mcp --socket /tmp/tribe.sock
bunx -p tribe-wire tribe mcp --socket /tmp/tribe.sock
npx -y --package=tribe-wire tribe mcp --socket /tmp/tribe.sock
```

The package name is `tribe-wire` because package runners need package names.
The binary is `tribe` because humans should type the product noun.

## Repository Layout

```text
packages/
  wire/      # npm tribe-wire; bin tribe
  daemon/    # npm tribe-daemon; bin tribe-daemon
plugins/
  claude/    # placeholder; published Claude plugin remains @bearly/tribe
docs/
  architecture.md
```

## Status

This repository is being extracted from `github.com/beorn/bearly`. The first
cut is additive: source is copied here while the old bearly paths remain in
place for cutover coordination. Destructive cleanup happens after package
publishing, plugin install, and downstream consumers are verified.
