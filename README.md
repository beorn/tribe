# Tribe

Reusable coordination + memory infrastructure for coding-agent sessions.

Tribe lets multiple agent sessions discover each other, exchange messages, and
share project context through a local daemon — with session-history recall
built in. This repository owns the reusable infrastructure only: wire protocol,
daemon, recall engine, and host integrations. Project workflow conventions such
as `@chief`, `@agent/N`, beads, worktrees, and integration policy belong in a
tent/SOP layer outside this repo.

## Quick start (Claude Code)

```text
/plugin marketplace add beorn/tribe
/plugin install tribe@tribe
```

Restart Claude Code; the `tribe.*` MCP tools (join, send, fetch, members, …)
appear and the daemon autostarts on first use. Two sessions on the same machine
can then talk: `tribe.join({name: "a"})` in one, `tribe.send({to: "a", ...})`
in the other.

## Components

| Component          | Package                    | Binary         | Owns                                                                          |
| ------------------ | -------------------------- | -------------- | ----------------------------------------------------------------------------- |
| Wire client        | `tribe-wire`               | `tribe-wire`   | Unix-socket client, reconnecting transport, MCP stdio adapter, protocol CLI   |
| Daemon             | `tribe-daemon`             | `tribe-daemon` | Broker process, SQLite state, session registry, message journal, plugins      |
| Recall engine      | `tribe-recall`             | n/a            | FTS5 session-history search, LLM planner/agent, hook handlers, lore summaries |
| Injection envelope | `tribe-injection-envelope` | n/a            | Prompt-injection defense: envelope framing, sanitizer, hook JSON emission     |
| Claude Code plugin | `plugins/claude`           | n/a            | Marketplace plugin: MCP registration + host-managed daemon lifecycle          |

`tribe-wire` is published to npm; the rest ship with this repository.

## Mental Model

```text
Claude / Codex / Hermes
  -> tribe-wire mcp            # from package tribe-wire
  -> local or SSH-forwarded Unix socket
  -> tribe-daemon
  -> SQLite + daemon plugins + recall engine
```

`tribe-wire` talks to an existing tribe. `tribe-daemon` is the broker process;
it lazy-loads the in-repo recall engine for memory verbs (`tribe.ask`,
`tribe.brief`, delta injection). Host plugins wire those pieces into an agent
runtime.

## LLM features (optional)

Coordination and FTS search work with zero configuration. Features that call an
LLM (synthesis, query planner, session summaries) need an external backend.
Host checkouts that include bearly are discovered automatically from
`vendor/bearly/plugins/llm/src` or a sibling `bearly/plugins/llm/src` checkout.
For custom layouts, point `TRIBE_LLM_DIR` at a directory exposing
`lib/types.ts`, `lib/research.ts`, and `lib/providers.ts`. Without a backend,
those features degrade to their documented no-LLM paths — loudly, never silently.

`TRIBE_RECALL_ENGINE_DIR` and `TRIBE_INJECTION_DEBUG_DIR` override the in-repo
engine/recorder locations for forks and experiments; you normally never set
them.

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
  wire/                # npm tribe-wire; bin tribe-wire
  daemon/              # tribe-daemon broker (private)
  recall/              # tribe-recall engine (private)
  injection-envelope/  # tribe-injection-envelope (private)
plugins/
  claude/              # Claude Code marketplace plugin (tribe@tribe)
docs/
  architecture.md
```

## Development

```bash
bun install
bun run test        # vitest, all packages
bun run typecheck
bun run fmt:check
```

## History

Extracted from `github.com/beorn/bearly` in June 2026 (km bead
`@km/bearly/19273-tribe-repo-split`), with `git subtree split` history for the
recall and injection-envelope packages. bearly retains the LLM toolkit
(`plugins/llm`) and a migration pointer.
