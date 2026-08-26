# Tribe

Cross-session coordination and session-history recall for AI coding agents.

Tribe gives multiple coding-agent sessions on one machine two things they
normally lack: a way to **talk to each other** while they work, and a way to
**search everything they've done before**. A local daemon lets sessions
discover each other, exchange messages, and track who owes whom a reply; a
separate recall engine indexes past Claude Code transcripts into full-text
search with optional LLM synthesis and file recovery.

The two pillars are independent — use coordination without recall, recall
without coordination, or both together. Neither requires an LLM to do its core
job; LLM features are opt-in and degrade loudly when unconfigured.

> **Scope.** This repo is _reusable infrastructure only_: wire protocol,
> broker daemon, recall engine, prompt-injection defense, and host plugins.
> Team workflow policy — named coordinator roles, worker numbering schemes,
> task queues, branch assignments, merge authority — is **not** part of Tribe.
> Those conventions belong to the consuming project's own workflow layer.
> Tribe transports messages and indexes history; it does not decide who is
> allowed to make a decision.

---

## The two pillars

| Pillar           | What it does                                                                                                                 | Core entry point                             |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| **Coordination** | Sessions join a tribe, send direct/broadcast messages, see who's online, and track open "balls" (requests awaiting a reply). | `tribe.*` MCP tools, or the `tribe-wire` CLI |
| **Recall**       | FTS5-indexed search over past Claude Code sessions, with LLM synthesis, file recovery, and daily/weekly summaries.           | `bun packages/recall/src/cli.ts "query"`     |

---

## Install

There are two ways in, depending on your host.

### Path A — Claude Code plugin

Installs the provider-owned coordination surface:

```text
/plugin marketplace add beorn/tribe
/plugin install tribe@tribe
```

Restart Claude Code. The `tribe.*` MCP tools (`join`, `send`, `fetch`,
`members`, `pending`, `health`, …) appear. The provider bridges are
connect-only: start the singleton broker through Hab, an explicit hook/install
lifecycle, or a manual daemon process before using those tools.

The plugin is intentionally thin: it wires Claude Code's stdio MCP transport to
`tribe-wire`'s adapter and never assumes ownership of the in-repo
`tribe-daemon`.
It does **not** install recall hooks — recall is set up separately (see
[Recall quickstart](#recall-quickstart)).

### Path B — npm wire client (`tribe-wire`)

For non-Claude agents (Codex, Gemini) or remote hosts that need to join an
existing tribe without bundling the daemon:

```bash
bunx tribe-wire mcp --socket /path/to/tribe.sock     # or:
npx -y tribe-wire mcp --socket /path/to/tribe.sock   # or, if installed globally:
tribe-wire mcp --socket /path/to/tribe.sock
```

`tribe-wire` is a **client**. It talks to a daemon over a Unix socket; it does
not start one. Point it at a socket that already exists — one owned by a
supervisor or explicit lifecycle hook, one you run from a repo clone (below),
or one forwarded over SSH. If no daemon is reachable, wire commands fail loudly
and tell you how to start one; they never silently no-op.

Register it as a plain project-level MCP server without plugin channels:

```json
{
  "mcpServers": {
    "tribe": { "command": "bunx", "args": ["tribe-wire", "mcp"] }
  }
}
```

Codex reads the same env-driven delivery mode. Long bounded waits use the CLI
rail, not MCP:

```toml
[mcp_servers.tribe.env]
TRIBE_DELIVERY = "pull"
```

Use that shape in `~/.codex/config.toml` for MCP-only clients without a
notification channel. MCP `inbox.wait` is limited by a measured 10,000ms host
ceiling; it defaults to a host-safe 5,000ms diagnostic, while requests at or
above the ceiling return typed `host_cut` with `advice: "cli_wait"` before the
daemon starts waiting. Run one `tribe inbox-wait --session <name>
--timeout <duration> --json` call for longer idle waits; never re-arm short MCP
calls into a polling loop.

### Running the daemon standalone (no plugin)

The daemon ships in this repo (it is not published to npm). From a clone:

```bash
bun install
bun packages/daemon/src/daemon.ts            # auto-discovers the socket path
bun packages/daemon/src/daemon.ts --socket ~/.local/share/tribe/tribe.sock
```

Then point any `tribe-wire` client at that socket.

---

## 60-second quickstart: two sessions talking

With the Claude Code plugin installed, open two sessions. Each joins under a
name, then they exchange messages through the shared daemon.

**Session A:**

```text
tribe.join({ name: "alice", role: "member" })
tribe.send({ to: "bob", message: "starting on the parser refactor", type: "notify" })
```

**Session B:**

```text
tribe.join({ name: "bob", role: "member" })
tribe.fetch({ limit: 10 })          // drains alice's message from the inbox
tribe.send({ to: "alice", message: "ack — I'll take the tests", type: "notify" })
```

`tribe.members()` in either session lists who's online. `tribe.send` with
`type: "request"` (or `query`/`assign`) opens a **pending ball** the recipient
owns until they reply — `tribe.pending()` shows the open pile, and
`tribe.fetch()` surfaces an `attention` projection (actionable unread +
oldest open balls) ahead of the chronological event log.

The same flow from a terminal, without Claude Code (a daemon must be running):

```bash
tribe-wire send '@bob' 'starting on the parser refactor' --type notify --anonymous
tribe-wire members            # JSON rows: name, role, launch_id, alive
tribe-wire log                # recent messages
tribe-wire pending            # open balls awaiting replies
```

The standalone shell has no managed seat identity, so this notification opts
into anonymous delivery explicitly. Managed provider seats omit `--anonymous`;
the daemon resolves and attributes them from their launch authority. Anonymous
delivery is restricted to untracked messages.

---

## Recall quickstart

Recall indexes your Claude Code transcripts (from `~/.claude/projects/**`) into
a SQLite FTS5 database and searches them. It ships **inside this repo** (the
`tribe-recall` package is not on npm), so standalone use means running it from a
clone.

```bash
bun install

# Search — LLM-synthesized narrative by default ("pointer mode")
bun packages/recall/src/cli.ts "the parser refactor we abandoned"

# Raw FTS5 hits, no LLM required
bun packages/recall/src/cli.ts "SQLITE_BUSY" --raw

# Multi-round LLM planner (plan -> fan out -> rerank -> synthesize)
bun packages/recall/src/cli.ts "why did we switch off autostash" --agent

# Build / refresh the index
bun packages/recall/src/cli.ts index --incremental

# Dashboard: activity, stats, index health, hook config
bun packages/recall/src/cli.ts status

# Sessions and file recovery
bun packages/recall/src/cli.ts sessions
bun packages/recall/src/cli.ts files --restore path/to/lost-file.ts

# Daily / weekly rollups
bun packages/recall/src/cli.ts summarize
bun packages/recall/src/cli.ts show week
```

**Freshness.** Before searching, the CLI checks the index age and auto-runs an
incremental refresh if it is older than `RECALL_STALE_THRESHOLD` (default `5m`),
printing a one-line stderr note. Every result envelope identifies index
`provenance`. On refresh failure, positive stale hits are preserved with exit 3;
a degraded empty response is `results: null`, `total: null`, never `[]`/`0`.
`--no-refresh` skips the subprocess but reports `unknown` provenance and exits 3.

**LLM vs no-LLM.** Raw FTS5 search, file recovery, and session listing work with
zero configuration. The synthesized default ("pointer mode") and the `--agent`
planner call an LLM — point `TRIBE_LLM_DIR` at an external backend (see
[Configuration](#configuration)) to enable them. Without it, use `--raw`.

### Recall as MCP tools (optional)

The repo also carries an MCP server (`plugins/claude/recall/server.ts`) that
exposes recall as `lore.*` tools — `lore.ask`, `lore.brief`, `lore.plan`,
`lore.session`, `lore.workspace`, `lore.inject_delta`. It is **not** registered
by the marketplace plugin; wire it in yourself if you want in-session recall:

```json
{
  "mcpServers": {
    "recall": {
      "command": "bun",
      "args": ["plugins/claude/recall/server.ts"]
    }
  }
}
```

When a Tribe daemon is running it hosts the same recall RPC surface, so the MCP
server proxies to it; otherwise it falls back to an in-process library call.

### Recall as Claude Code hooks (optional)

The recall CLI exposes hook-shaped subcommands so you can index automatically
instead of by hand:

- `index --incremental` — run from a **SessionStart** hook to keep the index warm.
- `remember` — reads a hook JSON blob on stdin; run from a **SessionEnd** hook to
  index the session that just finished.

The marketplace plugin does not install these — add them to your Claude Code
hook config (or adapt your host's) yourself.

---

## Components

| Component          | Package                    | Binary         | npm           | Owns                                                                                                                                                                                                               |
| ------------------ | -------------------------- | -------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Wire client        | `tribe-wire`               | `tribe-wire`   | ✅ published  | Unix-socket JSON-RPC client, reconnecting transport, MCP stdio + HTTP adapters, protocol CLI                                                                                                                       |
| Daemon             | `tribe-daemon`             | `tribe-daemon` | ships in repo | Broker process: Unix socket server, SQLite state, session registry, message journal, delivery modes, pending-ball tracker, health cadence, daemon plugins (git / github / health / `beads` issue-tracker observer) |
| Recall engine      | `tribe-recall`             | recall CLI     | ships in repo | FTS5 session-history search, LLM planner/agent, file recovery, summaries, hook handlers                                                                                                                            |
| Injection envelope | `tribe-injection-envelope` | n/a            | ships in repo | Prompt-injection defense: envelope framing, imperative-mood rewrite, sanitizer, turn-manifest authority gate                                                                                                       |
| Claude Code plugin | `plugins/claude`           | n/a            | marketplace   | `tribe@tribe`: MCP registration + host-managed daemon lifecycle                                                                                                                                                    |

Only `tribe-wire` is published to npm — a standalone client should not have to
pull in the daemon, recall wiring, or host hooks just to talk to a tribe. The
rest ship with this repository and run from a clone.

---

## Mental model

```text
Claude Code / Codex / Gemini / any MCP client
   │
   │  tribe.* MCP tools  (join, send, fetch, members, pending, health, …)
   ▼
tribe-wire  ──────────────►  MCP stdio adapter  (`tribe-wire mcp`)
   │
   │  JSON-RPC 2.0 over a local or SSH-forwarded Unix socket
   ▼
tribe-daemon  ── broker ──►  SQLite state · session registry · message journal
   │                          pending-ball tracker · delivery modes · health cadence
   │
   ├── daemon plugins  (git, github, health-monitor, issue-tracker event emitters)
   └── recall RPC surface  ──►  tribe-recall engine (FTS5 + optional LLM)
```

- **`tribe-wire`** is the protocol surface — everything an external agent needs
  to participate, and nothing more.
- **`tribe-daemon`** is the one long-running broker per project. It owns state
  and lifecycle; wire never silently owns lifecycle on its behalf.
- **Host plugins** wire those pieces into a specific runtime. Provider-owned
  bridges register MCP tools and connect to the singleton without taking over
  daemon lifecycle.

---

## Coordination model

A few concepts are worth knowing before you build on the coordination surface.

**Delivery: push vs pull.** Each session declares a delivery mode at join time,
and senders stay transport-blind — `tribe.send({to, message})` works the same
regardless of how the recipient receives it.

- **push** (default) — for clients with an MCP notification channel (Claude
  Code, Agent SDK). The daemon fans events out live; the client sees them as
  `<channel source="tribe">`.
- **pull** — for MCP-only clients without a notification reader (Codex, Gemini).
  Events queue in SQLite; the client drains them with `tribe.fetch`.

Delivery can also be set **per message**: `tribe.send(..., delivery: "pull")`
persists one message for inbox reads without a live wakeup, independent of the
recipient's session default. Delivery classification is orthogonal to ball
tracking — only message type and `request` decide whether a pending ball opens.

**Pending balls & attention.** A direct `request`, `query`, or `assign` message
opens exactly one recipient-owned "ball"; other types open one only when asked.
The ball stores ownership, age, and fanout. Tracked requests and queries receive
a 20-minute escalation deadline; assignments have no reply-clock default.
`expires_in_ms` overrides the class policy for one send. A reply closes the
original ownership row. `tribe.fetch()` returns a
read-only `attention` projection — actionable unread plus the oldest open balls
— ahead of the chronological events; `tribe.pending()` returns the full pile.
Deadline passage changes presentation, never membership: the ball becomes
`expired`, sorts first, and remains in the owner's pile. Reads compare the live
deadline directly, so they stay authoritative even if the durable
`ball.expired` observation echo waits for the next recorder sweep or daemon
boundary. `tribe.pending({ expired: true })` folds active rows, hot or archived
journal facts, and durable replies into one expired/unanswered view. A live
deadline-passed row has no settlement; terminal non-reply rows preserve
`manual-close`, `incident-cleared`, `gc-expired`, or `sender-withdrawn`; a later
answer is derived from the reply message and omitted. There is no second status
store. Paging, reminders, transfer, and escalation remain consumer policy.

**Health cadence.** The daemon projects a health snapshot — response-latency
percentiles by role and message type, open-ball counts and oldest age, per-
session inbox lag, and database growth — surfaced via `tribe.health` /
`tribe-wire health`. It reports; it does not act.

---

## Configuration

Everything works with zero configuration. These knobs are for LLM features,
custom paths, and observability.

| Variable                                               | Applies to         | Purpose                                                                                                                                                                                                                  |
| ------------------------------------------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `TRIBE_SOCKET`                                         | wire, daemon       | Override the daemon socket path                                                                                                                                                                                          |
| `TRIBE_DB`                                             | daemon             | Override the SQLite database path                                                                                                                                                                                        |
| `TRIBE_DELIVERY`                                       | wire (MCP adapter) | `push` or `pull` — threaded into the join call on start                                                                                                                                                                  |
| `TRIBE_LLM_DIR`                                        | recall, injection  | Directory exposing `lib/types.ts`, `lib/research.ts`, `lib/providers.ts`. Enables LLM synthesis, the query planner, and session summaries. Without it, those features degrade to their documented no-LLM paths — loudly. |
| `RECALL_STALE_THRESHOLD`                               | recall             | Index-freshness window before an auto-refresh (default `5m`; accepts `10m`, `1h`, `30s`, bare number = minutes)                                                                                                          |
| `TRIBE_LOG`                                            | recall MCP         | Set `1` to un-silence recall engine logging over MCP stderr                                                                                                                                                              |
| `TRIBE_NO_DAEMON`                                      | recall MCP         | Set `1` to force in-process library mode (skip the daemon)                                                                                                                                                               |
| `LOGGILY_FILE`, `DEBUG`                                | injection          | Wire a JSONL observability file and namespace filter (e.g. `DEBUG='injection:*'`)                                                                                                                                        |
| `TRIBE_RECALL_ENGINE_DIR`, `TRIBE_INJECTION_DEBUG_DIR` | forks              | Override in-repo engine/recorder locations. You normally never set these.                                                                                                                                                |

**Default paths.**

- **Socket:** `--socket` → `TRIBE_SOCKET` → `$XDG_RUNTIME_DIR/tribe.sock` →
  `$HOME/.local/share/tribe/tribe.sock`.
- **Database:** `--db` → `TRIBE_DB` → `$HOME/.local/share/tribe/tribe.db`
  (a legacy `.beads/tribe.db` is auto-migrated to the XDG path on first start).

---

## Requirements

- **Bun ≥ 1.3.13.** Bun is the runtime, package manager, and SQLite driver
  (`bun:sqlite`, WAL mode + FTS5) — no separate SQLite install needed.
- **macOS or Linux.** The daemon is a Unix-domain-socket server; run it under
  WSL on Windows.
- **An LLM backend (optional)** via `TRIBE_LLM_DIR` for recall synthesis, the
  query planner, and summaries. Everything else runs LLM-free.

---

## Repository layout

```text
packages/
  wire/                 # tribe-wire — npm client + `tribe-wire` CLI + MCP/HTTP adapters
  daemon/               # tribe-daemon — the broker (ships in repo)
  recall/               # tribe-recall — FTS5 search engine + recall CLI
  injection-envelope/   # tribe-injection-envelope — prompt-injection defense
plugins/
  claude/               # Claude Code marketplace plugin (tribe@tribe)
```

---

## Development

```bash
bun install
bun run test        # vitest, all packages
bun run typecheck   # tsc --noEmit
bun run fmt:check   # oxfmt --check
```

---

## Documentation

- [/hh/docs/reference/tribe/architecture.md](/hh/docs/reference/tribe/architecture.md) — the three reusable layers, the
  workflow-policy non-goal, and the dependency rule.
- [/hh/docs/reference/tribe/install.md](/hh/docs/reference/tribe/install.md) — both install paths in detail, plus
  verifying the daemon.
- [/hh/docs/reference/tribe/loops.md](/hh/docs/reference/tribe/loops.md) — keeping sessions responsive: message loops
  for Claude Code (push) and Codex / MCP-only hosts (pull).
- [/hh/docs/reference/tribe/recall.md](/hh/docs/reference/tribe/recall.md) — recall's CLI, index, hooks, and the
  injection-envelope defense.
- [/hh/docs/reference/tribe/wire-cli.md](/hh/docs/reference/tribe/wire-cli.md) — full `tribe-wire` verb reference.
- [/hh/docs/reference/tribe/daemon.md](/hh/docs/reference/tribe/daemon.md) — daemon lifecycle: autostart, election,
  hot-reload, troubleshooting.
- [packages/wire/README.md](packages/wire/README.md) — the full `tribe-wire` CLI
  verb reference and library exports.
- [packages/recall/README.md](packages/recall/README.md) — recall modes, index
  internals, and freshness behavior.
- [packages/injection-envelope/README.md](packages/injection-envelope/README.md)
  — the prompt-injection defense chokepoint.

---

## History

Extracted from `github.com/beorn/bearly` in June 2026, preserving the recall and
injection-envelope subtree history. bearly retains the shared LLM toolkit
(`plugins/llm`); Tribe consumes it through `TRIBE_LLM_DIR` rather than depending
on it directly.

## License

MIT © Bjørn Stabell
</content>
</invoke>
